import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensurePrivateDir } from "../store/home.js";
import { projectStoreDir, resolveProject } from "../store/project.js";
import { loadSqliteSync } from "../store/sqlite.js";

// One code index per checkout (worktrees can be on different branches), kept
// next to the project's memory but in its own file so indexing never contends
// with memory writes from the agent apps' hooks.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  blob       TEXT NOT NULL,
  lang       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  lines      INTEGER NOT NULL,
  est_tokens INTEGER NOT NULL,
  summary    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  path      TEXT NOT NULL,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  start     INTEGER NOT NULL,
  end       INTEGER NOT NULL,
  signature TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE TABLE IF NOT EXISTS chunks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  path            TEXT NOT NULL,
  symbol_id       INTEGER,
  name            TEXT NOT NULL,
  start           INTEGER NOT NULL,
  end             INTEGER NOT NULL,
  embedding       BLOB,
  embedding_model TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(path, name, text, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS edges (
  from_path TEXT NOT NULL,
  to_path   TEXT NOT NULL,
  PRIMARY KEY (from_path, to_path)
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface CodeIndexDb {
  db: DatabaseSync;
  root: string;
  path: string;
  close(): void;
}

export function codeIndexPath(cwd: string): { root: string; path: string } {
  const project = resolveProject(cwd);
  const key = createHash("sha256").update(project.root).digest("hex").slice(0, 12);
  return { root: project.root, path: join(ensurePrivateDir(join(projectStoreDir(cwd), "code")), `${key}.db`) };
}

export function openCodeIndex(cwd: string): CodeIndexDb | undefined {
  const sqlite = loadSqliteSync();
  if (!sqlite) return undefined;
  const { root, path } = codeIndexPath(cwd);
  try {
    const db = new sqlite.DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec(SCHEMA);
    return { db, root, path, close: () => db.close() };
  } catch {
    return undefined;
  }
}

export function metaGet(index: CodeIndexDb, key: string): string | undefined {
  return (index.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function metaSet(index: CodeIndexDb, key: string, value: string): void {
  index.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
