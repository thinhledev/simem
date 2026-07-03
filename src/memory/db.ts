import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION, SCHEMA_CORE, SCHEMA_FTS } from "./schema.js";

export interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

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

let cachedSqlite: SqliteModule | null | undefined;

export async function loadSqlite(): Promise<SqliteModule | undefined> {
  if (cachedSqlite !== undefined) return cachedSqlite ?? undefined;
  try {
    cachedSqlite = (await import("node:sqlite")) as unknown as SqliteModule;
  } catch {
    cachedSqlite = null;
  }
  return cachedSqlite ?? undefined;
}

export function memoryDbPath(cwd: string): string {
  return join(resolve(cwd), ".cag", "memory.db");
}

// Ordered migrations; index N upgrades schema_version N to N+1. Version 0 is
// an empty database. Each entry must be idempotent (IF NOT EXISTS guards).
const MIGRATIONS: Array<(db: DatabaseSync, fts: boolean) => void> = [
  (db, fts) => {
    db.exec(SCHEMA_CORE);
    if (fts) db.exec(SCHEMA_FTS);
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
    if (!options.quiet) process.stderr.write(`[cag] ${SQLITE_REQUIREMENT_MESSAGE}\n`);
    return undefined;
  }
  const path = options.path ?? memoryDbPath(cwd);
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new sqlite.DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
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
      process.stderr.write(`[cag] Could not open memory database at ${path}: ${message}\n`);
    }
    return undefined;
  }
}
