import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { MemoryConfig } from "../config.js";
import { cosineSimilarity, fromBlob, type EmbeddingClient } from "../memory/embeddings.js";
import { ftsQuery, queryTerms, reciprocalRankFusion } from "../memory/retrieval.js";
import { capText } from "../memory/text-cap.js";
import { resolveEmbeddings } from "../vec/client.js";
import { type CodeIndexDb, metaGet, openCodeIndex } from "./db.js";
import { indexRepository, type IndexStats } from "./indexer.js";

export interface CodeHit {
  path: string;
  name: string;
  kind: string;
  start: number;
  end: number;
  signature: string;
}

// Re-index when older than this; incremental runs only touch changed files.
const STALE_MS = 2 * 60_000;

export async function ensureIndexed(cwd: string, config?: MemoryConfig, options: { force?: boolean } = {}): Promise<{ index: CodeIndexDb; stats?: IndexStats } | undefined> {
  const index = openCodeIndex(cwd);
  if (!index) return undefined;
  const last = metaGet(index, "indexed_at");
  if (!options.force && last && Date.now() - Date.parse(last) < STALE_MS) return { index };
  try {
    const embeddings = await resolveEmbeddings(config);
    const stats = await indexRepository(index, embeddings);
    return { index, stats };
  } catch {
    return { index };
  }
}

interface ChunkRow {
  id: number;
  path: string;
  name: string;
  start: number;
  end: number;
  symbol_id: number | null;
}

function toHit(index: CodeIndexDb, row: ChunkRow): CodeHit {
  const symbol = row.symbol_id
    ? (index.db.prepare("SELECT kind, signature FROM symbols WHERE id = ?").get(row.symbol_id) as { kind: string; signature: string } | undefined)
    : undefined;
  return { path: row.path, name: row.name, kind: symbol?.kind ?? "file", start: row.start, end: row.end, signature: symbol?.signature ?? "" };
}

// Ranked code locations for a question or identifier — paths, line ranges,
// and signatures, never file bodies. The symbol-name column is weighted 4x.
export async function codeSearch(
  index: CodeIndexDb,
  query: string,
  options: { limit?: number; path?: string; embeddings?: EmbeddingClient } = {},
): Promise<CodeHit[]> {
  const limit = options.limit ?? 10;
  const match = ftsQuery(query);
  const pathFilter = options.path ? "AND c.path LIKE ?" : "";
  const pathParam = options.path ? [`${options.path.replace(/[%_]/g, "")}%`] : [];
  const lexical = match
    ? (index.db
        .prepare(
          `SELECT c.id, c.path, c.name, c.start, c.end, c.symbol_id FROM chunks_fts f JOIN chunks c ON c.id = f.rowid
           WHERE chunks_fts MATCH ? ${pathFilter} ORDER BY bm25(chunks_fts, 1.0, 4.0, 1.0) LIMIT ?`,
        )
        .all(match, ...pathParam, limit * 3) as unknown as ChunkRow[])
    : [];
  let ranked = lexical;
  // A bare identifier: its definition first, then everything else.
  const identifier = /^[A-Za-z_$][\w$]*$/.test(query.trim()) ? query.trim() : undefined;
  const definitions = identifier
    ? (index.db
        .prepare(
          `SELECT c.id, c.path, c.name, c.start, c.end, c.symbol_id FROM chunks c JOIN symbols s ON s.id = c.symbol_id
           WHERE s.name = ? ${pathFilter.replace("c.path", "c.path")} ORDER BY c.path LIMIT ?`,
        )
        .all(identifier, ...pathParam, limit) as unknown as ChunkRow[])
    : [];
  if (options.embeddings && !identifier && queryTerms(query).length > 0) {
    const [vector] = await options.embeddings.embed([query]);
    if (vector) {
      const rows = index.db
        .prepare(`SELECT c.id, c.path, c.name, c.start, c.end, c.symbol_id, c.embedding FROM chunks c WHERE c.embedding_model = ? ${pathFilter}`)
        .all(options.embeddings.model, ...pathParam) as unknown as Array<ChunkRow & { embedding: Uint8Array }>;
      const semantic = rows
        .map((row) => ({ row, score: cosineSimilarity(vector, fromBlob(row.embedding)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit * 3)
        .map(({ row }) => ({ id: row.id, path: row.path, name: row.name, start: row.start, end: row.end, symbol_id: row.symbol_id }));
      ranked = reciprocalRankFusion([lexical, semantic], (row) => String(row.id));
    }
  }
  if (definitions.length > 0) {
    const seen = new Set(definitions.map((row) => row.id));
    ranked = [...definitions, ...ranked.filter((row) => !seen.has(row.id))];
  }
  return ranked.slice(0, limit).map((row) => toHit(index, row));
}

function insideRoot(root: string, path: string): string {
  const absolute = isAbsolute(path) ? path : join(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is outside the project`);
  return absolute;
}

const MAX_READ_LINES = 400;

// Reads just one symbol (by name) or a line range from the live file.
export function codeRead(index: CodeIndexDb, path: string, selector: { symbol?: string; start?: number; end?: number }): { path: string; start: number; end: number; text: string; truncated: boolean } {
  const absolute = insideRoot(index.root, path);
  const rel = relative(index.root, absolute).replace(/\\/g, "/");
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  let start = selector.start ?? 1;
  let end = selector.end ?? lines.length;
  if (selector.symbol) {
    const symbol = index.db.prepare("SELECT start, end FROM symbols WHERE path = ? AND name = ? ORDER BY start LIMIT 1").get(rel, selector.symbol) as
      | { start: number; end: number }
      | undefined;
    if (!symbol) throw new Error(`No symbol ${selector.symbol} indexed in ${rel}; try code_outline`);
    ({ start, end } = symbol);
  }
  start = Math.max(1, start);
  end = Math.min(lines.length, Math.max(start, end));
  const truncated = end - start + 1 > MAX_READ_LINES;
  if (truncated) end = start + MAX_READ_LINES - 1;
  const text = lines
    .slice(start - 1, end)
    .map((line, i) => `${String(start + i).padStart(5)}  ${line}`)
    .join("\n");
  return { path: rel, start, end, text, truncated };
}

export function outlineFromIndex(index: CodeIndexDb, path: string): Array<{ name: string; kind: string; line: number; end: number }> | undefined {
  const absolute = insideRoot(index.root, path);
  const rel = relative(index.root, absolute).replace(/\\/g, "/");
  const file = index.db.prepare("SELECT 1 FROM files WHERE path = ?").get(rel);
  if (!file) return undefined;
  return index.db.prepare("SELECT name, kind, start AS line, end FROM symbols WHERE path = ? ORDER BY start").all(rel) as Array<{
    name: string;
    kind: string;
    line: number;
    end: number;
  }>;
}

// Files that might mention a symbol, from the index (a superset); the caller
// confirms with a word-boundary scan of just those files.
export function candidateFiles(index: CodeIndexDb, symbol: string): string[] {
  const rows = index.db.prepare("SELECT DISTINCT path FROM chunks_fts WHERE chunks_fts MATCH ?").all(`"${symbol.replaceAll('"', '""')}"`) as Array<{ path: string }>;
  return rows.map((row) => row.path);
}

// A compact, budgeted map: top-level directories with file counts, then the
// most connected files (by import in-degree) or those matching `focus`, each
// with a one-line summary. Deterministic for a given index.
export function repoMap(index: CodeIndexDb, options: { focus?: string; maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? 4_000;
  const files = index.db.prepare("SELECT path, est_tokens, summary FROM files ORDER BY path").all() as Array<{ path: string; est_tokens: number; summary: string }>;
  if (files.length === 0) return "";
  const dirs = new Map<string, { files: number; tokens: number }>();
  for (const file of files) {
    const top = file.path.includes("/") ? `${file.path.split("/")[0]}/` : "(root)";
    const entry = dirs.get(top) ?? { files: 0, tokens: 0 };
    entry.files += 1;
    entry.tokens += file.est_tokens;
    dirs.set(top, entry);
  }
  const dirLines = [...dirs.entries()]
    .sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([dir, entry]) => `- ${dir} ${entry.files} file(s), ~${Math.round(entry.tokens / 1000)}k tokens`);
  let key: Array<{ path: string; summary: string }>;
  if (options.focus && queryTerms(options.focus).length > 0) {
    const match = ftsQuery(options.focus);
    const paths = index.db
      .prepare("SELECT path, MIN(bm25(chunks_fts, 2.0, 4.0, 1.0)) AS score FROM chunks_fts WHERE chunks_fts MATCH ? GROUP BY path ORDER BY score LIMIT 10")
      .all(match) as Array<{ path: string }>;
    const byPath = new Map(files.map((file) => [file.path, file]));
    key = paths.map((row) => byPath.get(row.path)).filter((file): file is (typeof files)[number] => Boolean(file));
  } else {
    key = index.db
      .prepare(
        `SELECT f.path, f.summary FROM files f LEFT JOIN edges e ON e.to_path = f.path
         GROUP BY f.path ORDER BY COUNT(e.from_path) DESC, f.est_tokens DESC, f.path LIMIT 10`,
      )
      .all() as Array<{ path: string; summary: string }>;
  }
  const keyLines = key.map((file) => `- ${file.path} — ${capText(file.summary, 140).text}`);
  return capText([...dirLines, "", options.focus ? `Most relevant to "${options.focus}":` : "Key files:", ...keyLines].join("\n"), maxChars).text;
}
