import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { migrateLegacyStore } from "../store/migrate.js";
import { projectStoreDir, resolveProject } from "../store/project.js";
import { loadSqlite, type SqliteModule } from "../store/sqlite.js";

export { loadSqlite, type SqliteModule } from "../store/sqlite.js";
import { contentHash } from "./items.js";
import { CURRENT_SCHEMA_VERSION, SCHEMA_CORE, SCHEMA_FTS, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4, SCHEMA_V5_COLUMNS, SCHEMA_V5_INDEX, SCHEMA_V6 } from "./schema.js";

export interface MemoryDb {
  db: DatabaseSync;
  path: string;
  fts: boolean;
  schemaVersion: number;
  close(): void;
}

export interface OpenMemoryDbOptions {
  /** Override the database location; use ":memory:" in tests. */
  path?: string;
  /** Inject the sqlite module (tests); null simulates an unavailable runtime. */
  sqlite?: SqliteModule | null;
  /** Suppress the stderr warning when the runtime lacks node:sqlite. */
  quiet?: boolean;
}

export const SQLITE_REQUIREMENT_MESSAGE =
  `Persistent memory requires Node.js >= 22.5 (built-in node:sqlite); this runtime is ${process.version}. ` +
  "Core handoff commands keep working without it.";

// The project's store (global ~/.mixai/projects/<id> by default, or the
// repo's .mixai in project mode); a 1.x in-repo database is migrated into the
// global store the first time it is opened there.
export function memoryDbPath(cwd: string): string {
  const ref = resolveProject(cwd);
  if (ref.mode === "global") {
    const outcome = migrateLegacyStore(ref);
    // Another process holds the migration lock past the wait: read the
    // not-yet-copied legacy database rather than create an empty global one.
    if (outcome === "busy") return join(ref.root, ".mixai", "memory.db");
  }
  return join(projectStoreDir(cwd), "memory.db");
}

// Ordered migrations; index N upgrades schema_version N to N+1. Version 0 is
// an empty database. Each entry must be idempotent (IF NOT EXISTS guards).
const MIGRATIONS: Array<(db: DatabaseSync, fts: boolean) => void> = [
  (db, fts) => {
    db.exec(SCHEMA_CORE);
    if (fts) db.exec(SCHEMA_FTS);
  },
  (db) => {
    db.exec(SCHEMA_V2);
  },
  (db) => {
    db.exec(SCHEMA_V3);
  },
  (db) => {
    db.exec(SCHEMA_V4);
  },
  (db) => {
    const existing = new Set(
      (db.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    for (const [column, type] of Object.entries(SCHEMA_V5_COLUMNS)) {
      if (!existing.has(column)) db.exec(`ALTER TABLE memory_items ADD COLUMN ${column} ${type}`);
    }
    db.exec(SCHEMA_V5_INDEX);
    const rows = db.prepare("SELECT id, text FROM memory_items").all() as Array<{ id: number; text: string }>;
    const update = db.prepare("UPDATE memory_items SET content_hash = ? WHERE id = ? AND content_hash IS NULL");
    for (const row of rows) update.run(contentHash(row.text), row.id);
  },
  (db) => {
    db.exec(SCHEMA_V6);
  },
];

function probeFts(db: DatabaseSync): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x)");
    db.exec("DROP TABLE __fts_probe");
    return true;
  } catch {
    return false;
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

// Drops every managed table (FTS tables/triggers drop with their bases) and
// reapplies the schema from scratch. Rows are always rebuildable from the
// canonical checkpoint files via reindex, so this is safe by design.
export function resetMemoryDb(memory: MemoryDb): void {
  const drops = [
    "DROP TABLE IF EXISTS counters",
    "DROP TABLE IF EXISTS tool_reads",
    "DROP TABLE IF EXISTS outputs",
    "DROP TABLE IF EXISTS hook_runs",
    "DROP TABLE IF EXISTS injections",
    "DROP TABLE IF EXISTS events",
    "DROP TABLE IF EXISTS turn_usage",
    "DROP TABLE IF EXISTS sessions",
    "DROP TABLE IF EXISTS savings_events",
    "DROP TABLE IF EXISTS llm_calls",
    "DROP TABLE IF EXISTS consolidation_queue",
    "DROP TABLE IF EXISTS messages_fts",
    "DROP TABLE IF EXISTS memory_items_fts",
    "DROP TABLE IF EXISTS summaries_fts",
    "DROP TABLE IF EXISTS messages",
    "DROP TABLE IF EXISTS memory_items",
    "DROP TABLE IF EXISTS summaries",
    "DROP TABLE IF EXISTS checkpoints",
    "DROP TABLE IF EXISTS meta",
  ];
  for (const drop of drops) memory.db.exec(drop);
  let version = 0;
  while (version < CURRENT_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new Error(`No migration from memory schema version ${version}`);
    migrate(memory.db, memory.fts);
    version += 1;
  }
  memory.db
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(String(version));
}

export async function openMemoryDb(
  cwd: string,
  options: OpenMemoryDbOptions = {},
): Promise<MemoryDb | undefined> {
  const sqlite = options.sqlite === undefined ? await loadSqlite() : options.sqlite ?? undefined;
  if (!sqlite) {
    if (!options.quiet) process.stderr.write(`[mixai] ${SQLITE_REQUIREMENT_MESSAGE}\n`);
    return undefined;
  }
  const path = options.path ?? memoryDbPath(cwd);
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new sqlite.DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    // Two apps (or an app and a background ingest) may write at once: wait
    // for the lock briefly instead of failing with SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 3000");
    const fts = probeFts(db);
    let version = readSchemaVersion(db);
    while (version < CURRENT_SCHEMA_VERSION) {
      const migrate = MIGRATIONS[version];
      if (!migrate) throw new Error(`No migration from memory schema version ${version}`);
      migrate(db, fts);
      version += 1;
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(version));
    }
    return { db, path, fts, schemaVersion: version, close: () => db.close() };
  } catch (error) {
    if (!options.quiet) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[mixai] Could not open memory database at ${path}: ${message}\n`);
    }
    return undefined;
  }
}
