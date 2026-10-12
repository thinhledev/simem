import type { MemoryDb } from "../memory/db.js";
import { recordSavings } from "../memory/savings.js";
import type { CodeIndexDb } from "./db.js";
import type { CodeHit } from "./search.js";

function fileBytes(index: CodeIndexDb, path: string): number {
  return (index.db.prepare("SELECT bytes FROM files WHERE path = ?").get(path) as { bytes: number } | undefined)?.bytes ?? 0;
}

// code_search: an estimate, labelled as such in `mixai stats` — the
// alternative is reading the files behind the top hits; what was sent is the
// hit list itself.
export function recordCodeSavings(memory: MemoryDb | undefined, index: CodeIndexDb, hits: CodeHit[]): void {
  if (!memory || hits.length === 0) return;
  const files = [...new Set(hits.slice(0, 3).map((hit) => hit.path))];
  recordSavings(memory, {
    mechanism: "code-search",
    charsFull: files.reduce((sum, path) => sum + fileBytes(index, path), 0),
    charsSent: JSON.stringify(hits).length,
  });
}

// code_read: exact — the whole file vs the span returned.
export function recordReadSavings(memory: MemoryDb | undefined, index: CodeIndexDb, span: { path: string; text: string }): void {
  if (!memory) return;
  recordSavings(memory, { mechanism: "code-read", charsFull: fileBytes(index, span.path), charsSent: span.text.length });
}
