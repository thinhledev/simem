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
  /**
   * Minimum IDF-weighted share of the query's terms a row must contain (0–1).
   * Default 0: deliberate searches show anything that matches a term.
   * Automatic injection raises it so weak, one-common-word matches stay out.
   */
  minCoverage?: number;
  /** Minimum number of distinct query terms a row must contain (capped at the query's term count). */
  minMatchedTerms?: number;
  /**
   * Vector gate (needs `embeddings`): a row that misses the keyword gate still
   * passes with cosine >= minSimilarity when it covers at least
   * anchorCoverage of the query's terms, or with cosine >= strongSimilarity
   * alone. Undefined = keyword gate only.
   */
  minSimilarity?: number;
  strongSimilarity?: number;
  anchorCoverage?: number;
}

export interface InjectionGate {
  minCoverage: number;
  minMatchedTerms: number;
  minSimilarity?: number;
  strongSimilarity?: number;
  anchorCoverage?: number;
}

/** Keyword part of the gate for paths that inject memory without being asked. */
export const AUTOMATIC_INJECTION_GATE: InjectionGate = { minCoverage: 0.5, minMatchedTerms: 2 };

// The automatic gate for a config: keywords always; the vector path only when
// cutoffs were set (calibrated per model with `mixai eval`).
export function automaticGate(embeddings: { minSimilarity: number; strongSimilarity: number }): InjectionGate {
  return {
    ...AUTOMATIC_INJECTION_GATE,
    ...(embeddings.minSimilarity > 0 ? { minSimilarity: embeddings.minSimilarity, anchorCoverage: 0.2 } : {}),
    ...(embeddings.strongSimilarity > 0 ? { strongSimilarity: embeddings.strongSimilarity } : {}),
  };
}

export function vectorGateEnabled(embeddings: { minSimilarity: number; strongSimilarity: number }): boolean {
  return embeddings.minSimilarity > 0 || embeddings.strongSimilarity > 0;
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

// Function words plus words that frame a question rather than name its topic
// ("why did we decide…", "remember…"). They carry no retrieval signal, and
// leaving them in made natural-language prompts require words no memory row
// ever contains.
const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but
  by can could did do does doing done down during each few for from further had has have having he her here hers him
  his how i if in into is it its itself just let lets me more most my no nor not now of off on once only or other our
  ours out over own same she should so some such than that the their theirs them then there these they this those
  through to too under until up us very was we were what when where which while who whom why will with would you your
  yours yes yeah ok okay sure please thanks thank continue go ahead proceed lgtm hi hello hey want need like make use
  used using get got also still really actually maybe decide decided decision decisions choose chose chosen pick
  picked reason reasons explain remember recall tell know think`
    .split(/\s+/)
    .filter(Boolean),
);

const MAX_QUERY_TERMS = 12;

// Topic terms for a free-text query. Splits the same way FTS5's unicode61
// tokenizer does (anything that isn't a letter or digit), so `CLAUDE.local.md`
// becomes claude/local/md and matches what was indexed. Empty for prompts with
// no topic words ("yes, continue"), which callers treat as "nothing to find".
export function queryTerms(raw: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const word of raw.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
    if (terms.length === MAX_QUERY_TERMS) break;
  }
  return terms;
}

function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

// FTS5 treats -, (, ", NEAR, AND, OR as syntax, and space-separated terms as
// AND — which made a prompt match only when every one of its words appeared in
// a single row. Terms are OR-ed instead; how much of the query a row actually
// covers is measured separately (see termCoverage) and gates weak matches.
export function ftsQuery(raw: string): string {
  return queryTerms(raw).map(quoteFtsTerm).join(" OR ");
}

function likePattern(term: string): string {
  return `%${term.replaceAll(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function likeClauses(terms: string[], column: string): { where: string; params: string[] } {
  const where = terms.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" OR ");
  return { where: where || "0", params: terms.map(likePattern) };
}

const MIN_IDF_CORPUS = 20;

const SOURCE_TABLES: Record<RetrievalHit["source"], { table: string; fts: string }> = {
  message: { table: "messages", fts: "messages_fts" },
  memory_item: { table: "memory_items", fts: "memory_items_fts" },
  summary: { table: "summaries", fts: "summaries_fts" },
};

// BM25-style IDF per term, so rare, specific words ("handoff", "cowork") count
// for more than words that appear in most rows. A term no row contains keeps a
// high weight on purpose: a question about something memory has never seen
// should lower every row's coverage rather than be silently ignored.
function inverseDocumentFrequencies(memory: MemoryDb, source: RetrievalHit["source"], terms: string[]): Map<string, number> {
  const { table, fts } = SOURCE_TABLES[source];
  // Smoothed for small stores: with only a handful of memories, every word in
  // them would otherwise look "common" (near-zero weight) and one unknown word
  // in the question would outweigh several genuine matches.
  const total = Math.max(MIN_IDF_CORPUS, (memory.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const count = memory.fts
    ? memory.db.prepare(`SELECT COUNT(*) AS n FROM ${fts} WHERE ${fts} MATCH ?`)
    : memory.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE text LIKE ? ESCAPE '\\'`);
  const weights = new Map<string, number>();
  for (const term of terms) {
    const df = (count.get(memory.fts ? quoteFtsTerm(term) : likePattern(term)) as { n: number }).n;
    weights.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
  }
  return weights;
}

// Which query terms each candidate row contains. With FTS5 this asks SQLite
// per term, so its own stemming decides ("hooks" matches "hook"); the LIKE
// fallback uses a case-insensitive substring check.
function termCoverage(memory: MemoryDb, source: RetrievalHit["source"], terms: string[], hits: RawHit[]): void {
  if (hits.length === 0) return;
  const weights = inverseDocumentFrequencies(memory, source, terms);
  const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  const matched = new Map<number, string[]>(hits.map((hit) => [hit.id, []]));
  if (memory.fts) {
    const { fts } = SOURCE_TABLES[source];
    const ids = [...matched.keys()];
    const statement = memory.db.prepare(
      `SELECT rowid AS id FROM ${fts} WHERE ${fts} MATCH ? AND rowid IN (${ids.map(() => "?").join(",")})`,
    );
    for (const term of terms) {
      for (const row of statement.all(quoteFtsTerm(term), ...ids) as Array<{ id: number }>) matched.get(row.id)?.push(term);
    }
  } else {
    for (const hit of hits) {
      const text = hit.text.toLowerCase();
      matched.set(hit.id, terms.filter((term) => text.includes(term)));
    }
  }
  for (const hit of hits) {
    const hitTerms = matched.get(hit.id) ?? [];
    const weight = hitTerms.reduce((sum, term) => sum + (weights.get(term) ?? 0), 0);
    hit.matchedTerms = hitTerms;
    hit.coverage = totalWeight > 0 ? weight / totalWeight : 0;
  }
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
  /** IDF-weighted share of the query's terms this row contains (0–1). */
  coverage?: number;
  matchedTerms?: string[];
  /** Cosine similarity to the query, when embeddings are in use. */
  similarity?: number;
}

function queryMessages(memory: MemoryDb, terms: string[], limit: number, options: SearchOptions): RawHit[] {
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
      .all(terms.map(quoteFtsTerm).join(" OR "), ...dateRange.params, limit) as typeof rows;
  } else {
    const { where, params } = likeClauses(terms, "m.text");
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

function queryMemoryItems(memory: MemoryDb, terms: string[], limit: number, options: SearchOptions): RawHit[] {
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
      .all(terms.map(quoteFtsTerm).join(" OR "), ...extraParams, ...dateRange.params, limit) as typeof rows;
  } else {
    const { where, params } = likeClauses(terms, "i.text");
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

function querySummaries(memory: MemoryDb, terms: string[], limit: number, options: SearchOptions): RawHit[] {
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
      .all(terms.map(quoteFtsTerm).join(" OR "), ...dateRange.params, limit) as typeof rows;
  } else {
    const { where, params } = likeClauses(terms, "s.text");
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
  }));
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
  }));
}

// Scores every embedded row (exact scan), returns the top `limit`, and
// records each row's similarity so lexical hits can be gated on it too.
function rankByCosine(rows: EmbeddedRow[], queryVector: Float32Array, limit: number, similarities: Map<string, number>): RawHit[] {
  return rows
    .map((row) => {
      const similarity = cosineSimilarity(queryVector, row.embedding);
      similarities.set(hitKey(row.raw), similarity);
      return { raw: { ...row.raw, similarity }, similarity };
    })
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
      const matchedTerms = raw.matchedTerms ?? [];
      // Coverage is comparable across sources, unlike list position. A row the
      // vector search found but that shares no query term still needs a
      // relevance, so it gets a damped position-based one.
      const relevance =
        matchedTerms.length > 0
          ? Math.max(raw.coverage ?? 0, raw.similarity ?? 0)
          : raw.similarity ?? 0.5 / (1 + index);
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
        matchedTerms,
        score:
          scoring.recencyWeight * recency +
          scoring.importanceWeight * importanceComponent +
          scoring.relevanceWeight * relevance,
      });
    });
  }
  return hits.sort((left, right) => right.score - left.score);
}

function passesGate(hit: RawHit, terms: string[], options: SearchOptions): boolean {
  const minMatched = Math.min(options.minMatchedTerms ?? 0, terms.length);
  const coverage = hit.coverage ?? 0;
  if (coverage >= (options.minCoverage ?? 0) && (hit.matchedTerms?.length ?? 0) >= minMatched) return true;
  const similarity = hit.similarity;
  if (similarity === undefined) return false;
  if (options.strongSimilarity !== undefined && similarity >= options.strongSimilarity) return true;
  return options.minSimilarity !== undefined && similarity >= options.minSimilarity && coverage >= (options.anchorCoverage ?? 0);
}

export async function search(memory: MemoryDb, query: string, options: SearchOptions = {}): Promise<RetrievalHit[]> {
  const raw = query.trim();
  const terms = queryTerms(raw);
  if (terms.length === 0) return [];
  const limit = options.limit ?? 10;
  const perSource = Math.max(limit, 10);

  const itemsFts = queryMemoryItems(memory, terms, perSource, options);
  const summariesFts = options.kind ? [] : querySummaries(memory, terms, perSource, options);
  const messagesFts = options.kind || options.excludeMessages ? [] : queryMessages(memory, terms, perSource, options);

  let items = itemsFts;
  let summaries = summariesFts;
  if (options.embeddings) {
    try {
      const [queryVector] = await options.embeddings.embed([raw]);
      if (queryVector) {
        const similarities = new Map<string, number>();
        const itemRows = vectorRankItems(memory, options.embeddings.model, perSource * 4, options);
        const itemsVector = rankByCosine(itemRows, queryVector, perSource, similarities);
        items = reciprocalRankFusion([itemsFts, itemsVector], hitKey);
        if (!options.kind) {
          const summaryRows = vectorRankSummaries(memory, options.embeddings.model, perSource * 4, options);
          const summariesVector = rankByCosine(summaryRows, queryVector, perSource, similarities);
          summaries = reciprocalRankFusion([summariesFts, summariesVector], hitKey);
        }
        for (const hit of [...items, ...summaries]) {
          const similarity = similarities.get(hitKey(hit));
          if (similarity !== undefined) hit.similarity = similarity;
        }
      }
    } catch {
      // Embedding backend failed mid-query; fall back to the FTS-only ranking.
    }
  }

  termCoverage(memory, "memory_item", terms, items);
  termCoverage(memory, "summary", terms, summaries);
  termCoverage(memory, "message", terms, messagesFts);
  const lists: RawHit[][] = (options.kind ? [items] : [items, summaries, messagesFts]).map((list) =>
    list.filter((hit) => passesGate(hit, terms, options)),
  );
  return scoreHits(lists, options).slice(0, limit);
}
