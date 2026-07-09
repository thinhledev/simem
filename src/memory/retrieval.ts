import type { MemoryDb } from "./db.js";
import { cosineSimilarity, fromBlob, type EmbeddingClient } from "./embeddings.js";
import type { MemoryCategory, MemoryKind, RetrievalHit } from "./types.js";

export interface ScoringWeights {
  recencyWeight: number;
  importanceWeight: number;
  relevanceWeight: number;
  halfLifeDays: number;
}

export const DEFAULT_SCORING: ScoringWeights = {
  recencyWeight: 0.2,
  importanceWeight: 0.3,
  relevanceWeight: 0.5,
  halfLifeDays: 30,
};

export interface SearchOptions {
  limit?: number;
  kind?: MemoryKind;
  includeSuperseded?: boolean;
  scoring?: ScoringWeights;
  now?: string;
  /** When set, memory_items/summaries are re-ranked by fusing keyword and vector search (RRF). */
  embeddings?: EmbeddingClient;
  /** memory_items.category filter — pushed into SQL, not applied client-side. */
  category?: MemoryCategory;
  /** memory_items.importance >= this value — pushed into SQL. */
  minImportance?: number;
  /** ISO timestamp lower bound (inclusive), compared as strings against each row's own date column. */
  since?: string;
  /** ISO timestamp upper bound (inclusive). */
  until?: string;
  /**
   * Skip raw checkpoint messages, searching only memory_items and summaries
   * (the curated content). Automatic injection paths (buildMemoryContextBlock)
   * set this — raw messages are noisy for an unattended "here's relevant
   * context" surface and can surface low-value results, like a prompt
   * matching an earlier, near-identical question verbatim. Deliberate
   * searches (cag memory search, the memory_search MCP tool) leave it unset,
   * since broader recall is exactly what a human-invoked search wants.
   */
  excludeMessages?: boolean;
}

function dateRangeClause(column: string, since: string | undefined, until: string | undefined): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (since) {
    clauses.push(`${column} >= ?`);
    params.push(since);
  }
  if (until) {
    clauses.push(`${column} <= ?`);
    params.push(until);
  }
  return { sql: clauses.map((clause) => `AND ${clause}`).join(" "), params };
}

// Reciprocal rank fusion: score(d) = sum(1 / (k + rank_i(d))) across every
// ranked list d appears in. Items only in one list still get one term, so a
// candidate found solely by keyword or solely by vector search can still surface.
export function reciprocalRankFusion<T>(lists: T[][], keyOf: (item: T) => string, k = 60): T[] {
  const scores = new Map<string, number>();
  const items = new Map<string, T>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = keyOf(item);
      items.set(key, item);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...items.entries()]
    .sort((left, right) => (scores.get(right[0]) ?? 0) - (scores.get(left[0]) ?? 0))
    .map(([, item]) => item);
}

// FTS5 treats -, (, ", NEAR, AND, OR as syntax. Quoting every whitespace
// token turns arbitrary code identifiers and error strings into literal
// phrase terms; internal double quotes are doubled per SQL quoting rules.
export function ftsQuery(raw: string): string {
  const tokens = raw
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ");
}

function likeClauses(raw: string, column: string): { where: string; params: string[] } {
  const tokens = raw.split(/\s+/).filter(Boolean);
  const where = tokens.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" AND ");
  const params = tokens.map((token) => `%${token.replaceAll(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  return { where: where || "1", params };
}

function recencyScore(timestamp: string | undefined, now: number, halfLifeDays: number): number {
  if (!timestamp) return 0;
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return 0;
  const ageDays = Math.max(0, (now - then) / 86_400_000);
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

interface RawHit {
  source: RetrievalHit["source"];
  id: number;
  text: string;
  checkpointId?: string;
  timestamp?: string;
  importance?: number;
}

function queryMessages(memory: MemoryDb, raw: string, limit: number, options: SearchOptions): RawHit[] {
  const dateRange = dateRangeClause("c.created_at", options.since, options.until);
  let rows: Array<{ id: number; text: string; checkpoint_id: string; created_at: string }>;
  if (memory.fts) {
    rows = memory.db
      .prepare(
        `SELECT m.id, m.text, m.checkpoint_id, c.created_at
         FROM messages_fts f
         JOIN messages m ON m.id = f.rowid
         JOIN checkpoints c ON c.id = m.checkpoint_id
         WHERE messages_fts MATCH ? ${dateRange.sql}
         ORDER BY bm25(messages_fts) LIMIT ?`,
      )
      .all(ftsQuery(raw), ...dateRange.params, limit) as typeof rows;
  } else {
    const { where, params } = likeClauses(raw, "m.text");
    rows = memory.db
      .prepare(
        `SELECT m.id, m.text, m.checkpoint_id, c.created_at
         FROM messages m JOIN checkpoints c ON c.id = m.checkpoint_id
         WHERE ${where} ${dateRange.sql} ORDER BY c.created_at DESC LIMIT ?`,
      )
      .all(...params, ...dateRange.params, limit) as typeof rows;
  }
  return rows.map((row) => ({
    source: "message" as const,
    id: row.id,
    text: row.text,
    checkpointId: row.checkpoint_id,
    timestamp: row.created_at,
  }));
}

function queryMemoryItems(memory: MemoryDb, raw: string, limit: number, options: SearchOptions): RawHit[] {
  const extra: string[] = [];
  const extraParams: Array<string | number> = [];
  if (options.kind) {
    extra.push("AND i.kind = ?");
    extraParams.push(options.kind);
  }
  if (options.category) {
    extra.push("AND i.category = ?");
    extraParams.push(options.category);
  }
  if (options.minImportance !== undefined) {
    extra.push("AND i.importance >= ?");
    extraParams.push(options.minImportance);
  }
  const dateRange = dateRangeClause("i.created_at", options.since, options.until);
  const extraFilter = `${extra.join(" ")} ${dateRange.sql}`;
  let rows: Array<{
    id: number;
    text: string;
    source_checkpoint_id: string | null;
    last_reinforced_at: string;
    importance: number;
  }>;
  if (memory.fts) {
    rows = memory.db
      .prepare(
        `SELECT i.id, i.text, i.source_checkpoint_id, i.last_reinforced_at, i.importance
         FROM memory_items_fts f
         JOIN memory_items i ON i.id = f.rowid
         WHERE memory_items_fts MATCH ? AND i.status = 'active' ${extraFilter}
         ORDER BY bm25(memory_items_fts) LIMIT ?`,
      )
      .all(ftsQuery(raw), ...extraParams, ...dateRange.params, limit) as typeof rows;
  } else {
    const { where, params } = likeClauses(raw, "i.text");
    rows = memory.db
      .prepare(
        `SELECT i.id, i.text, i.source_checkpoint_id, i.last_reinforced_at, i.importance
         FROM memory_items i
         WHERE ${where} AND i.status = 'active' ${extraFilter}
         ORDER BY i.importance DESC LIMIT ?`,
      )
      .all(...params, ...extraParams, ...dateRange.params, limit) as typeof rows;
  }
  return rows.map((row) => ({
    source: "memory_item" as const,
    id: row.id,
    text: row.text,
    ...(row.source_checkpoint_id ? { checkpointId: row.source_checkpoint_id } : {}),
    timestamp: row.last_reinforced_at,
    importance: row.importance,
  }));
}

function querySummaries(memory: MemoryDb, raw: string, limit: number, options: SearchOptions): RawHit[] {
  const supersededFilter = options.includeSuperseded ? "" : "AND s.superseded_by IS NULL";
  const dateRange = dateRangeClause("s.created_at", options.since, options.until);
  let rows: Array<{ id: number; text: string; covers_to: string; created_at: string }>;
  if (memory.fts) {
    rows = memory.db
      .prepare(
        `SELECT s.id, s.text, s.covers_to, s.created_at
         FROM summaries_fts f
         JOIN summaries s ON s.id = f.rowid
         WHERE summaries_fts MATCH ? ${supersededFilter} ${dateRange.sql}
         ORDER BY bm25(summaries_fts) LIMIT ?`,
      )
      .all(ftsQuery(raw), ...dateRange.params, limit) as typeof rows;
  } else {
    const { where, params } = likeClauses(raw, "s.text");
    rows = memory.db
      .prepare(
        `SELECT s.id, s.text, s.covers_to, s.created_at
         FROM summaries s WHERE ${where} ${supersededFilter} ${dateRange.sql}
         ORDER BY s.created_at DESC LIMIT ?`,
      )
      .all(...params, ...dateRange.params, limit) as typeof rows;
  }
  return rows.map((row) => ({
    source: "summary" as const,
    id: row.id,
    text: row.text,
    checkpointId: row.covers_to,
    timestamp: row.created_at,
  }));
}

interface EmbeddedRow {
  raw: RawHit;
  embedding: Float32Array;
}

// Linear cosine scan — fine at this project's scale (hundreds to low
// thousands of rows). Only rows embedded with the currently configured
// model are considered; stale-model vectors are silently excluded rather
// than compared across incompatible embedding spaces.
function vectorRankItems(memory: MemoryDb, model: string, limit: number, options: SearchOptions): EmbeddedRow[] {
  const extra: string[] = [];
  const extraParams: Array<string | number> = [];
  if (options.kind) {
    extra.push("AND kind = ?");
    extraParams.push(options.kind);
  }
  if (options.category) {
    extra.push("AND category = ?");
    extraParams.push(options.category);
  }
  if (options.minImportance !== undefined) {
    extra.push("AND importance >= ?");
    extraParams.push(options.minImportance);
  }
  const dateRange = dateRangeClause("created_at", options.since, options.until);
  const rows = memory.db
    .prepare(
      `SELECT id, text, source_checkpoint_id, last_reinforced_at, importance, embedding
       FROM memory_items
       WHERE status = 'active' AND embedding IS NOT NULL AND embedding_model = ? ${extra.join(" ")} ${dateRange.sql}`,
    )
    .all(model, ...extraParams, ...dateRange.params) as Array<{
    id: number;
    text: string;
    source_checkpoint_id: string | null;
    last_reinforced_at: string;
    importance: number;
    embedding: Buffer;
  }>;
  return rows.map((row) => ({
    raw: {
      source: "memory_item" as const,
      id: row.id,
      text: row.text,
      ...(row.source_checkpoint_id ? { checkpointId: row.source_checkpoint_id } : {}),
      timestamp: row.last_reinforced_at,
      importance: row.importance,
    },
    embedding: fromBlob(row.embedding),
  })).slice(0, limit);
}

function vectorRankSummaries(memory: MemoryDb, model: string, limit: number, options: SearchOptions): EmbeddedRow[] {
  const supersededFilter = options.includeSuperseded ? "" : "AND superseded_by IS NULL";
  const dateRange = dateRangeClause("created_at", options.since, options.until);
  const rows = memory.db
    .prepare(
      `SELECT id, text, covers_to, created_at, embedding FROM summaries
       WHERE embedding IS NOT NULL AND embedding_model = ? ${supersededFilter} ${dateRange.sql}`,
    )
    .all(model, ...dateRange.params) as Array<{ id: number; text: string; covers_to: string; created_at: string; embedding: Buffer }>;
  return rows.map((row) => ({
    raw: { source: "summary" as const, id: row.id, text: row.text, checkpointId: row.covers_to, timestamp: row.created_at },
    embedding: fromBlob(row.embedding),
  })).slice(0, limit);
}

function rankByCosine(rows: EmbeddedRow[], queryVector: Float32Array, limit: number): RawHit[] {
  return rows
    .map((row) => ({ raw: row.raw, similarity: cosineSimilarity(queryVector, row.embedding) }))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, limit)
    .map((entry) => entry.raw);
}

function hitKey(hit: RawHit): string {
  return `${hit.source}:${hit.id}`;
}

function scoreHits(lists: RawHit[][], options: SearchOptions): RetrievalHit[] {
  const scoring = options.scoring ?? DEFAULT_SCORING;
  const now = options.now ? Date.parse(options.now) : Date.now();
  const hits: RetrievalHit[] = [];
  for (const list of lists) {
    list.forEach((raw, index) => {
      const relevance = 1 / (1 + index);
      const recency = recencyScore(raw.timestamp, now, scoring.halfLifeDays);
      const importanceComponent = raw.importance === undefined ? 0.5 : raw.importance / 10;
      hits.push({
        source: raw.source,
        id: raw.id,
        text: raw.text,
        ...(raw.checkpointId ? { checkpointId: raw.checkpointId } : {}),
        relevance,
        recency,
        ...(raw.importance !== undefined ? { importance: raw.importance } : {}),
        score:
          scoring.recencyWeight * recency +
          scoring.importanceWeight * importanceComponent +
          scoring.relevanceWeight * relevance,
      });
    });
  }
  return hits.sort((left, right) => right.score - left.score);
}

export async function search(memory: MemoryDb, query: string, options: SearchOptions = {}): Promise<RetrievalHit[]> {
  const raw = query.trim();
  if (!raw) return [];
  const limit = options.limit ?? 10;
  const perSource = Math.max(limit, 10);

  const itemsFts = queryMemoryItems(memory, raw, perSource, options);
  const summariesFts = options.kind ? [] : querySummaries(memory, raw, perSource, options);
  const messagesFts = options.kind || options.excludeMessages ? [] : queryMessages(memory, raw, perSource, options);

  let items = itemsFts;
  let summaries = summariesFts;
  if (options.embeddings) {
    try {
      const [queryVector] = await options.embeddings.embed([raw]);
      if (queryVector) {
        const itemRows = vectorRankItems(memory, options.embeddings.model, perSource * 4, options);
        const itemsVector = rankByCosine(itemRows, queryVector, perSource);
        items = reciprocalRankFusion([itemsFts, itemsVector], hitKey);
        if (!options.kind) {
          const summaryRows = vectorRankSummaries(memory, options.embeddings.model, perSource * 4, options);
          const summariesVector = rankByCosine(summaryRows, queryVector, perSource);
          summaries = reciprocalRankFusion([summariesFts, summariesVector], hitKey);
        }
      }
    } catch {
      // Embedding backend failed mid-query; fall back to the FTS-only ranking.
    }
  }

  const lists: RawHit[][] = options.kind ? [items] : [items, summaries, messagesFts];
  return scoreHits(lists, options).slice(0, limit);
}
