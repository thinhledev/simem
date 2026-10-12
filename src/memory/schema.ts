export const CURRENT_SCHEMA_VERSION = 6;

// Core relational tables. Raw checkpoint files on disk stay canonical; every
// row here is derivable by re-running `mixai memory reindex`.
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

// v2: token/cost ledger. Every orchestrator-mediated LLM call is recorded so
// spend can be attributed by purpose/provider/day. prompt_chars/output_chars
// are always exact; token columns are NULL when the provider reported no
// usage, in which case `estimated = 1` marks chars/4 estimates downstream.
export const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS llm_calls (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose            TEXT NOT NULL,
  provider           TEXT NOT NULL,
  checkpoint_id      TEXT REFERENCES checkpoints(id),
  session_id         TEXT,
  prompt_chars       INTEGER NOT NULL,
  output_chars       INTEGER NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           REAL,
  estimated          INTEGER NOT NULL DEFAULT 0,
  duration_ms        INTEGER NOT NULL,
  ok                 INTEGER NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_purpose_date ON llm_calls(purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_calls_provider_date ON llm_calls(provider, created_at);
`;

// v3: lets consolidation flag a checkpoint's summary as a milestone — a
// distinct, nameable completed objective — so rollups can weight it instead
// of treating every checkpoint as equally routine.
export const SCHEMA_V3 = `
ALTER TABLE summaries ADD COLUMN milestone INTEGER NOT NULL DEFAULT 0;
`;

// v4: records exact, mechanism-attributed token/char savings from mixai's own
// compression — recursive compaction, preview-vs-full disclosure, and the
// consolidation/rollup prompt caps. Deliberately does NOT attempt a "vs not
// using mixai at all" figure: that requires knowing what a from-scratch agent
// would have spent re-exploring the repo, which mixai cannot observe. Every row
// here is a real chars_full - chars_sent delta measured at the moment the
// saving happened, forward-looking only from whenever this shipped.
export const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS savings_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mechanism  TEXT NOT NULL,
  chars_full INTEGER NOT NULL,
  chars_sent INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_savings_events_mechanism ON savings_events(mechanism, created_at);
`;

// v5: provenance and dedupe for memory items. `origin` records which tier
// wrote the item (rule | llm | agent | user | import); `content_hash` is the
// hash of the normalized text, so a fact restated by a later checkpoint or a
// second tier reinforces the existing row instead of duplicating it.
// ADD COLUMN has no IF NOT EXISTS, so the migration adds only the columns
// that are missing (see db.ts) to stay idempotent.
export const SCHEMA_V5_COLUMNS = { origin: "TEXT", content_hash: "TEXT" } as const;
export const SCHEMA_V5_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_memory_items_content_hash ON memory_items(content_hash, status)";

// v6: continuous capture. Each agent session is ingested incrementally (no
// switch or compaction needed) as a "session:<agent>:<id>" pseudo-checkpoint,
// so messages, FTS, distillation, and compaction reuse the checkpoint
// machinery. Alongside: real provider usage per turn, tool events, and the
// per-session bookkeeping for injection dedupe, hook dedupe, compressed
// command outputs, and read tracking.
export const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY REFERENCES checkpoints(id),
  agent            TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  source_dir       TEXT,
  surface          TEXT NOT NULL DEFAULT 'unknown',
  cwd              TEXT NOT NULL,
  title            TEXT,
  app_summary      TEXT,
  model            TEXT,
  transcript_path  TEXT,
  started_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  message_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_activity_at);

CREATE TABLE IF NOT EXISTS turn_usage (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL,
  usage_key          TEXT NOT NULL,
  ts                 TEXT,
  model              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(session_id, usage_key)
);
CREATE INDEX IF NOT EXISTS idx_turn_usage_ts ON turn_usage(ts);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  call_id    TEXT,
  ts         TEXT,
  type       TEXT NOT NULL,
  tool       TEXT NOT NULL,
  target     TEXT,
  bytes      INTEGER,
  exit_code  INTEGER,
  ok         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_session_call ON events(session_id, call_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, target);

CREATE TABLE IF NOT EXISTS injections (
  session_id TEXT NOT NULL,
  ref        TEXT NOT NULL,
  ts         TEXT NOT NULL,
  PRIMARY KEY (session_id, ref)
);

CREATE TABLE IF NOT EXISTS hook_runs (
  key TEXT PRIMARY KEY,
  ts  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outputs (
  id         TEXT PRIMARY KEY,
  session_id TEXT,
  command    TEXT NOT NULL,
  raw_gz     BLOB NOT NULL,
  raw_chars  INTEGER NOT NULL,
  sent_chars INTEGER NOT NULL,
  exit_code  INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outputs_created ON outputs(created_at);

CREATE TABLE IF NOT EXISTS tool_reads (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  full       INTEGER NOT NULL,
  ts         TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);

CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;
