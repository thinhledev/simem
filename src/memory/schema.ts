export const CURRENT_SCHEMA_VERSION = 1;

// Core relational tables. Raw checkpoint files on disk stay canonical; every
// row here is derivable by re-running `cag memory reindex`.
export const SCHEMA_CORE = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id                   TEXT PRIMARY KEY,
  created_at           TEXT NOT NULL,
  workspace            TEXT NOT NULL,
  source_provider      TEXT NOT NULL,
  source_session_id    TEXT NOT NULL,
  lineage_mode         TEXT NOT NULL,
  parent_checkpoint_id TEXT REFERENCES checkpoints(id),
  target_provider      TEXT,
  target_session_id    TEXT,
  branch               TEXT,
  head                 TEXT,
  dirty                INTEGER NOT NULL DEFAULT 0,
  directory            TEXT NOT NULL,
  manifest_json        TEXT NOT NULL,
  consolidation_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_created_at ON checkpoints(created_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_parent ON checkpoints(parent_checkpoint_id);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL,
  text          TEXT NOT NULL,
  timestamp     TEXT,
  UNIQUE(checkpoint_id, seq)
);

CREATE TABLE IF NOT EXISTS memory_items (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT NOT NULL,
  category             TEXT,
  text                 TEXT NOT NULL,
  importance           INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  superseded_by        INTEGER REFERENCES memory_items(id),
  source_checkpoint_id TEXT REFERENCES checkpoints(id),
  created_at           TEXT NOT NULL,
  last_reinforced_at   TEXT NOT NULL,
  embedding            BLOB,
  embedding_model      TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_items_status ON memory_items(status, kind);

CREATE TABLE IF NOT EXISTS summaries (
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
);
CREATE INDEX IF NOT EXISTS idx_summaries_level ON summaries(level, superseded_by);

CREATE TABLE IF NOT EXISTS consolidation_queue (
  checkpoint_id TEXT PRIMARY KEY REFERENCES checkpoints(id),
  queued_at     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);
`;

// FTS5 layer: external-content tables plus sync triggers. Applied only when
// the runtime SQLite build supports FTS5; search falls back to LIKE otherwise.
export const SCHEMA_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
  text,
  content='memory_items',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_items_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE OF text ON memory_items BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memory_items_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  text,
  content='summaries',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE OF text ON summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO summaries_fts(rowid, text) VALUES (new.id, new.text);
END;
`;
