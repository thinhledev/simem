import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSqlite, memoryDbPath, openMemoryDb, resetMemoryDb } from "../src/memory/db.js";
import { CURRENT_SCHEMA_VERSION } from "../src/memory/schema.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

test("returns undefined without throwing when node:sqlite is unavailable", async () => {
  const memory = await openMemoryDb(process.cwd(), { sqlite: null, quiet: true });
  assert.equal(memory, undefined);
});

test("creates the schema and reports FTS5 support", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    assert.equal(memory.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(memory.fts, true);
    const tables = memory.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((table) => table.name);
    for (const expected of ["meta", "checkpoints", "messages", "memory_items", "summaries", "consolidation_queue", "llm_calls", "savings_events"]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }
  } finally {
    memory.close();
  }
});

test("upgrades an existing v1 database (no llm_calls table) to v2 transparently", withSqlite, async () => {
  const root = await mkdtemp(join(tmpdir(), "mixai-memory-db-v1-"));
  // Simulate a database left behind by the pre-ledger schema: apply only the
  // v1 DDL and stamp schema_version=1, bypassing the migration runner.
  const v1 = await openMemoryDb(root, { path: join(root, "memory.db") });
  assert.ok(v1);
  v1.db.exec("DROP TABLE IF EXISTS llm_calls");
  // Also strip the v3 `milestone` column so replaying v2's and v3's
  // migrations against this rewound database doesn't re-add it.
  v1.db.exec("ALTER TABLE summaries RENAME TO summaries_old");
  v1.db.exec(`
    CREATE TABLE summaries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      level            INTEGER NOT NULL,
      text             TEXT NOT NULL,
      covers_from      TEXT NOT NULL,
      covers_to        TEXT NOT NULL,
      checkpoint_count INTEGER NOT NULL,
      created_at       TEXT NOT NULL,
      superseded_by    INTEGER REFERENCES summaries(id),
      embedding        BLOB,
      embedding_model  TEXT
    )
  `);
  v1.db.exec("DROP TABLE summaries_old");
  v1.db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  v1.close();

  const upgraded = await openMemoryDb(root, { path: join(root, "memory.db") });
  assert.ok(upgraded);
  try {
    assert.equal(upgraded.schemaVersion, CURRENT_SCHEMA_VERSION);
    const tables = upgraded.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('llm_calls', 'savings_events')")
      .all();
    assert.equal(tables.length, 2);
    const columns = upgraded.db.prepare("PRAGMA table_info(summaries)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "milestone"));
  } finally {
    upgraded.close();
  }
});

test("upgrades an existing v2 database (no summaries.milestone column) to v3+ transparently", withSqlite, async () => {
  const root = await mkdtemp(join(tmpdir(), "mixai-memory-db-v2-"));
  const v2 = await openMemoryDb(root, { path: join(root, "memory.db") });
  assert.ok(v2);
  // Simulate a pre-milestone database: recreate `summaries` without the
  // `milestone` column and stamp schema_version=2, bypassing the migration runner.
  v2.db.exec("ALTER TABLE summaries RENAME TO summaries_old");
  v2.db.exec(`
    CREATE TABLE summaries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      level            INTEGER NOT NULL,
      text             TEXT NOT NULL,
      covers_from      TEXT NOT NULL,
      covers_to        TEXT NOT NULL,
      checkpoint_count INTEGER NOT NULL,
      created_at       TEXT NOT NULL,
      superseded_by    INTEGER REFERENCES summaries(id),
      embedding        BLOB,
      embedding_model  TEXT
    )
  `);
  v2.db.exec("DROP TABLE summaries_old");
  v2.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  v2.close();

  const upgraded = await openMemoryDb(root, { path: join(root, "memory.db") });
  assert.ok(upgraded);
  try {
    assert.equal(upgraded.schemaVersion, CURRENT_SCHEMA_VERSION);
    const columns = upgraded.db.prepare("PRAGMA table_info(summaries)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "milestone"));
    const tables = upgraded.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='savings_events'")
      .all();
    assert.equal(tables.length, 1);
  } finally {
    upgraded.close();
  }
});

test("upgrades an existing v3 database (no savings_events table) to v4 transparently", withSqlite, async () => {
  const root = await mkdtemp(join(tmpdir(), "mixai-memory-db-v3-"));
  const v3 = await openMemoryDb(root, { path: join(root, "memory.db") });
  assert.ok(v3);
  v3.db.exec("DROP TABLE IF EXISTS savings_events");
  v3.db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
  v3.close();

  const upgraded = await openMemoryDb(root, { path: join(root, "memory.db") });
  assert.ok(upgraded);
  try {
    assert.equal(upgraded.schemaVersion, CURRENT_SCHEMA_VERSION);
    const tables = upgraded.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='savings_events'")
      .all();
    assert.equal(tables.length, 1);
  } finally {
    upgraded.close();
  }
});

test("resetMemoryDb drops and recreates llm_calls and savings_events too", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    memory.db
      .prepare(
        "INSERT INTO llm_calls (purpose, provider, prompt_chars, output_chars, estimated, duration_ms, ok, created_at) " +
          "VALUES ('run', 'claude', 10, 10, 0, 1, 1, '2026-07-03T00:00:00Z')",
      )
      .run();
    memory.db
      .prepare("INSERT INTO savings_events (mechanism, chars_full, chars_sent, created_at) VALUES ('compaction', 100, 10, '2026-07-03T00:00:00Z')")
      .run();
    resetMemoryDb(memory);
    const llmCount = memory.db.prepare("SELECT COUNT(*) AS n FROM llm_calls").get() as { n: number };
    assert.equal(llmCount.n, 0);
    const savingsCount = memory.db.prepare("SELECT COUNT(*) AS n FROM savings_events").get() as { n: number };
    assert.equal(savingsCount.n, 0);
  } finally {
    memory.close();
  }
});

test("keeps FTS index rows in sync through triggers", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    memory.db
      .prepare(
        "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
          "VALUES ('cp-1', '2026-07-03T00:00:00Z', '/tmp/w', 'codex', 's-1', 'export', 'dir', '{}')",
      )
      .run();
    memory.db
      .prepare("INSERT INTO messages (checkpoint_id, seq, role, text) VALUES ('cp-1', 0, 'user', 'refactor the auth middleware')")
      .run();
    const hits = memory.db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?")
      .all('"auth"') as Array<{ rowid: number }>;
    assert.equal(hits.length, 1);
  } finally {
    memory.close();
  }
});

test("reopening an existing database is idempotent and preserves rows", withSqlite, async () => {
  const root = await mkdtemp(join(tmpdir(), "mixai-memory-db-"));
  const first = await openMemoryDb(root);
  assert.ok(first);
  assert.equal(first.path, memoryDbPath(root));
  first.db
    .prepare(
      "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
        "VALUES ('cp-keep', '2026-07-03T00:00:00Z', '/tmp/w', 'codex', 's-1', 'export', 'dir', '{}')",
    )
    .run();
  first.close();

  const second = await openMemoryDb(root);
  assert.ok(second);
  try {
    assert.equal(second.schemaVersion, CURRENT_SCHEMA_VERSION);
    const row = second.db.prepare("SELECT id FROM checkpoints WHERE id = 'cp-keep'").get() as
      | { id: string }
      | undefined;
    assert.equal(row?.id, "cp-keep");
  } finally {
    second.close();
  }
});

test("upgrades a v4 database to v5: adds origin/content_hash and backfills hashes for existing items", withSqlite, async () => {
  const root = await mkdtemp(join(tmpdir(), "mixai-memory-db-v4-"));
  const v4 = await openMemoryDb(root, { path: join(root, "memory.db") });
  assert.ok(v4);
  // Rewind to the v4 shape: memory_items without the v5 columns.
  v4.db.exec("DROP INDEX IF EXISTS idx_memory_items_content_hash");
  v4.db.exec("ALTER TABLE memory_items DROP COLUMN content_hash");
  v4.db.exec("ALTER TABLE memory_items DROP COLUMN origin");
  v4.db
    .prepare(
      "INSERT INTO memory_items (kind, text, importance, created_at, last_reinforced_at) VALUES ('semantic', 'Never use dependency X.', 9, 't', 't')",
    )
    .run();
  v4.db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
  v4.close();

  const upgraded = await openMemoryDb(root, { path: join(root, "memory.db") });
  assert.ok(upgraded);
  try {
    assert.equal(upgraded.schemaVersion, CURRENT_SCHEMA_VERSION);
    const row = upgraded.db.prepare("SELECT origin, content_hash FROM memory_items").get() as {
      origin: string | null;
      content_hash: string | null;
    };
    assert.equal(row.origin, null, "pre-v5 items have unknown provenance");
    assert.match(row.content_hash ?? "", /^[0-9a-f]{32}$/);
  } finally {
    upgraded.close();
  }
});
