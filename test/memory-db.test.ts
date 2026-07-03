import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSqlite, memoryDbPath, openMemoryDb } from "../src/memory/db.js";
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
    for (const expected of ["meta", "checkpoints", "messages", "memory_items", "summaries", "consolidation_queue"]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }
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
  const root = await mkdtemp(join(tmpdir(), "cag-memory-db-"));
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
