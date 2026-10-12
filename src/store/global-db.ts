import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadSqliteSync } from "./sqlite.js";
import { ensurePrivateDir, mixaiHome } from "./home.js";

// The cross-project registry: which project every path, root commit, and
// remote belongs to, plus memory that applies to all of a user's projects.
const GLOBAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_keys (
  key         TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id)
);
CREATE TABLE IF NOT EXISTS project_paths (
  path        TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  last_seen   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS global_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  category           TEXT,
  text               TEXT NOT NULL,
  importance         INTEGER NOT NULL,
  content_hash       TEXT NOT NULL UNIQUE,
  origin             TEXT NOT NULL,
  source_project_id  TEXT,
  created_at         TEXT NOT NULL,
  last_reinforced_at TEXT NOT NULL
);
`;

export function globalDbPath(): string {
  return join(mixaiHome(), "global.db");
}

// Opened per call and closed by the caller; undefined when node:sqlite is
// unavailable (the caller then falls back to path-only identity).
export function openGlobalDb(): DatabaseSync | undefined {
  const sqlite = loadSqliteSync();
  if (!sqlite) return undefined;
  ensurePrivateDir(mixaiHome());
  const db = new sqlite.DatabaseSync(globalDbPath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec(GLOBAL_SCHEMA);
  return db;
}
