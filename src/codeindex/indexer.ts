import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, normalize, relative } from "node:path";
import { detectLanguage, outlineText } from "../codemap/outline.js";
import { toBlob, type EmbeddingClient } from "../memory/embeddings.js";
import { capText, oneLine } from "../memory/text-cap.js";
import { type CodeIndexDb, metaSet } from "./db.js";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_CHUNK_LINES = 120;
const PLAIN_CHUNK_LINES = 80;
const MAX_PLAIN_CHUNKS = 3;

const SKIP_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|\.next|\.nuxt|target|__pycache__|\.venv|venv|\.simem|\.mixai|\.turbo|\.cache)(\/|$)/;
const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "go.sum", "composer.lock", "Gemfile.lock", "bun.lockb"]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".wav", ".sqlite", ".db", ".wasm", ".jar", ".class", ".so", ".dylib", ".dll", ".exe", ".bin", ".safetensors", ".lockb",
]);

export function shouldIndex(path: string, bytes: number): boolean {
  if (SKIP_DIRS.test(path)) return false;
  const name = basename(path);
  if (SKIP_FILES.has(name)) return false;
  if (BINARY_EXT.has(extname(name).toLowerCase())) return false;
  if (/\.min\.(js|css)$/.test(name) || name.endsWith(".map")) return false;
  return bytes <= MAX_FILE_BYTES;
}

interface Listed {
  path: string;
  /** Git blob sha for tracked files; mtime:size for untracked ones. */
  blob: string;
}

// Tracked files with their blob shas, plus untracked-but-not-ignored files.
// Outside a git repository: a bounded directory walk.
export function listFiles(root: string): Listed[] {
  try {
    const tracked = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const files: Listed[] = [];
    for (const entry of tracked.split("\0")) {
      const match = /^\d+ ([0-9a-f]+) \d+\t(.+)$/.exec(entry);
      if (match?.[1] && match[2]) files.push({ path: match[2], blob: match[1] });
    }
    const untracked = execFileSync("git", ["ls-files", "-o", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    for (const path of untracked.split("\0").filter(Boolean)) {
      try {
        const info = statSync(join(root, path));
        files.push({ path, blob: `${Math.round(info.mtimeMs)}:${info.size}` });
      } catch {
        // Vanished between listing and stat.
      }
    }
    return files;
  } catch {
    return [];
  }
}

// "computeInvoiceTotal" / "compute_invoice_total" → "compute invoice total":
// the FTS tokenizer keeps identifiers whole, so plain-language questions
// would otherwise never match a symbol's name.
export function splitIdentifier(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_$\-.]+/g, " ")
    .toLowerCase()
    .trim();
}

function searchableName(name: string): string {
  const split = splitIdentifier(name);
  return split && split !== name.toLowerCase() ? `${name} ${split}` : name;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

export interface IndexedSymbol {
  name: string;
  kind: string;
  start: number;
  end: number;
  signature: string;
}

// End line for each symbol: just before the next symbol at the same or a
// shallower indentation (methods end at the next method or the class end).
export function symbolsWithRanges(source: string, language: string): IndexedSymbol[] {
  const lines = source.split(/\r?\n/);
  const { symbols } = outlineText(source, language);
  return symbols.map((symbol, index) => {
    const indent = indentOf(lines[symbol.line - 1] ?? "");
    let end = lines.length;
    for (const next of symbols.slice(index + 1)) {
      if (indentOf(lines[next.line - 1] ?? "") <= indent) {
        end = next.line - 1;
        break;
      }
    }
    while (end > symbol.line && !(lines[end - 1] ?? "").trim()) end -= 1;
    return { name: symbol.name, kind: symbol.kind, start: symbol.line, end, signature: capText(oneLine(lines[symbol.line - 1] ?? ""), 160).text };
  });
}

function leadingDoc(source: string): string {
  const block = /^\s*(?:\/\*\*?([\s\S]*?)\*\/|((?:\s*(?:\/\/|#)[^\n]*\n)+)|"""([\s\S]*?)""")/.exec(source);
  const raw = block?.[1] ?? block?.[2] ?? block?.[3] ?? "";
  return capText(oneLine(raw.replace(/^\s*(?:\*|\/\/|#)\s?/gm, " ")), 200).text;
}

export function fileSummary(path: string, source: string, symbols: IndexedSymbol[]): string {
  const doc = leadingDoc(source);
  const exported = [...source.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const names = (exported.length > 0 ? exported : symbols.map((symbol) => symbol.name)).slice(0, 12);
  return [doc, names.length > 0 ? `${exported.length > 0 ? "exports" : "defines"}: ${names.join(", ")}` : ""].filter(Boolean).join(" — ") || basename(path);
}

const IMPORT_PATTERNS = [
  /(?:import|export)[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g,
  /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
];

function resolveImport(from: string, spec: string, known: Set<string>): string | undefined {
  const base = normalize(join(dirname(from), spec)).replace(/\\/g, "/");
  const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`, `${stem}/index.ts`, `${stem}/index.js`, `${base}.py`]) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

export interface IndexStats {
  files: number;
  changed: number;
  removed: number;
  symbols: number;
  chunks: number;
  embedded: number;
  ms: number;
}

// Incremental: only files whose blob sha (or mtime:size) changed are parsed.
export async function indexRepository(index: CodeIndexDb, embeddings?: EmbeddingClient): Promise<IndexStats> {
  const started = Date.now();
  const listed = listFiles(index.root).filter((file) => {
    try {
      return shouldIndex(file.path, statSync(join(index.root, file.path)).size);
    } catch {
      return false;
    }
  });
  const known = new Map((index.db.prepare("SELECT path, blob FROM files").all() as Array<{ path: string; blob: string }>).map((row) => [row.path, row.blob]));
  const present = new Set(listed.map((file) => file.path));
  const stats: IndexStats = { files: listed.length, changed: 0, removed: 0, symbols: 0, chunks: 0, embedded: 0, ms: 0 };
  const removeFile = (path: string) => {
    for (const row of index.db.prepare("SELECT id FROM chunks WHERE path = ?").all(path) as Array<{ id: number }>) {
      index.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(row.id);
    }
    index.db.prepare("DELETE FROM chunks WHERE path = ?").run(path);
    index.db.prepare("DELETE FROM symbols WHERE path = ?").run(path);
    index.db.prepare("DELETE FROM edges WHERE from_path = ?").run(path);
    index.db.prepare("DELETE FROM files WHERE path = ?").run(path);
  };
  const pendingEmbeds: Array<{ id: number; text: string }> = [];
  index.db.exec("BEGIN");
  try {
    for (const path of known.keys()) {
      if (!present.has(path)) {
        removeFile(path);
        stats.removed += 1;
      }
    }
    const insertFile = index.db.prepare("INSERT INTO files (path, blob, lang, bytes, lines, est_tokens, summary) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertSymbol = index.db.prepare("INSERT INTO symbols (path, name, kind, start, end, signature) VALUES (?, ?, ?, ?, ?, ?)");
    const insertChunk = index.db.prepare("INSERT INTO chunks (path, symbol_id, name, start, end) VALUES (?, ?, ?, ?, ?)");
    const insertFts = index.db.prepare("INSERT INTO chunks_fts (rowid, path, name, text) VALUES (?, ?, ?, ?)");
    const insertEdge = index.db.prepare("INSERT OR IGNORE INTO edges (from_path, to_path) VALUES (?, ?)");
    const changedFiles: Array<{ path: string; source: string }> = [];
    for (const file of listed) {
      if (known.get(file.path) === file.blob) continue;
      let source: string;
      try {
        const buffer = readFileSync(join(index.root, file.path));
        if (buffer.subarray(0, 8000).includes(0)) continue; // binary
        source = buffer.toString("utf8");
      } catch {
        continue;
      }
      if (known.has(file.path)) removeFile(file.path);
      stats.changed += 1;
      const language = detectLanguage(file.path);
      const lines = source.split(/\r?\n/);
      const symbols = language === "unknown" && !/\.(md|txt|json|ya?ml|toml)$/.test(file.path) ? [] : symbolsWithRanges(source, language);
      insertFile.run(file.path, file.blob, language, source.length, lines.length, Math.round(source.length / 3.6), fileSummary(file.path, source, symbols));
      for (const symbol of symbols) {
        const result = insertSymbol.run(file.path, symbol.name, symbol.kind, symbol.start, symbol.end, symbol.signature);
        stats.symbols += 1;
        const end = Math.min(symbol.end, symbol.start + MAX_CHUNK_LINES - 1);
        const text = lines.slice(symbol.start - 1, end).join("\n");
        const chunk = insertChunk.run(file.path, Number(result.lastInsertRowid), symbol.name, symbol.start, end);
        insertFts.run(Number(chunk.lastInsertRowid), file.path, searchableName(symbol.name), text);
        pendingEmbeds.push({ id: Number(chunk.lastInsertRowid), text: `${file.path} ${symbol.signature}\n${text.slice(0, 1500)}` });
        stats.chunks += 1;
      }
      if (symbols.length === 0) {
        for (let start = 1, n = 0; start <= lines.length && n < MAX_PLAIN_CHUNKS; start += PLAIN_CHUNK_LINES, n += 1) {
          const end = Math.min(lines.length, start + PLAIN_CHUNK_LINES - 1);
          const text = lines.slice(start - 1, end).join("\n");
          if (!text.trim()) continue;
          const chunk = insertChunk.run(file.path, null, basename(file.path), start, end);
          insertFts.run(Number(chunk.lastInsertRowid), file.path, searchableName(basename(file.path)), text);
          pendingEmbeds.push({ id: Number(chunk.lastInsertRowid), text: `${file.path}\n${text.slice(0, 1500)}` });
          stats.chunks += 1;
        }
      }
      changedFiles.push({ path: file.path, source });
    }
    for (const { path, source } of changedFiles) {
      for (const pattern of IMPORT_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          const target = match[1] ? resolveImport(path, match[1], present) : undefined;
          if (target && target !== path) insertEdge.run(path, target);
        }
      }
    }
    metaSet(index, "indexed_at", new Date().toISOString());
    index.db.exec("COMMIT");
  } catch (error) {
    index.db.exec("ROLLBACK");
    throw error;
  }
  if (embeddings && pendingEmbeds.length > 0) {
    const update = index.db.prepare("UPDATE chunks SET embedding = ?, embedding_model = ? WHERE id = ?");
    index.db.exec("BEGIN");
    try {
      for (let offset = 0; offset < pendingEmbeds.length; offset += 256) {
        const batch = pendingEmbeds.slice(offset, offset + 256);
        const vectors = await embeddings.embed(batch.map((entry) => entry.text));
        batch.forEach((entry, i) => {
          const vector = vectors[i];
          if (vector) {
            update.run(toBlob(vector), embeddings.model, entry.id);
            stats.embedded += 1;
          }
        });
      }
      index.db.exec("COMMIT");
    } catch {
      index.db.exec("ROLLBACK");
    }
  }
  stats.ms = Date.now() - started;
  return stats;
}

export function relativeTo(root: string, path: string): string {
  return relative(root, path).replace(/\\/g, "/");
}
