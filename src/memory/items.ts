import { createHash } from "node:crypto";
import type { MemoryDb } from "./db.js";
import type { MemoryCategory, MemoryKind } from "./types.js";

// Which distillation tier (or person) wrote a memory item.
export const MEMORY_ORIGINS = ["rule", "llm", "agent", "user", "import"] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

// Case, punctuation, markdown backticks, and whitespace never make two facts
// different, so they are stripped before hashing and comparing.
export function normalizeMemoryText(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function contentHash(text: string): string {
  return createHash("sha256").update(normalizeMemoryText(text)).digest("hex").slice(0, 32);
}

function wordSet(text: string): Set<string> {
  return new Set(normalizeMemoryText(text).split(" ").filter((word) => word.length > 1));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

// Word-overlap threshold for treating two items as the same fact restated.
// Deliberately high: a false merge loses a fact, a missed merge only costs a
// near-duplicate row. Vector similarity replaces this in Phase 3.
const NEAR_DUPLICATE_JACCARD = 0.8;

export interface MemoryItemInput {
  kind: MemoryKind;
  category?: MemoryCategory;
  text: string;
  importance: number;
  origin: MemoryOrigin;
  sourceCheckpointId?: string | null;
  supersedes?: number;
}

export interface UpsertResult {
  id: number;
  /** True when an existing active item was reinforced instead of a new row being inserted. */
  reinforced: boolean;
}

function findDuplicate(memory: MemoryDb, input: MemoryItemInput, hash: string): number | undefined {
  const exact = memory.db
    .prepare("SELECT id FROM memory_items WHERE content_hash = ? AND status = 'active' LIMIT 1")
    .get(hash) as { id: number } | undefined;
  if (exact) return exact.id;
  const words = wordSet(input.text);
  const candidates = memory.db
    .prepare("SELECT id, text FROM memory_items WHERE status = 'active' AND kind = ? AND category IS ?")
    .all(input.kind, input.category ?? null) as Array<{ id: number; text: string }>;
  for (const candidate of candidates) {
    if (jaccard(words, wordSet(candidate.text)) >= NEAR_DUPLICATE_JACCARD) return candidate.id;
  }
  return undefined;
}

// Single write path for memory items. A fact that is already stored (same
// normalized text, or a near-identical restatement of the same kind and
// category) is reinforced: it keeps its id, its last_reinforced_at moves to
// when it was restated (never backwards, so a backfill over old checkpoints
// can't make a fact look fresher or staler than it is), and it keeps the
// higher importance. `now` is when the fact was stated, e.g. the checkpoint's time.
export function upsertMemoryItem(memory: MemoryDb, input: MemoryItemInput, now = new Date().toISOString()): UpsertResult {
  const hash = contentHash(input.text);
  const duplicate = findDuplicate(memory, input, hash);
  if (duplicate !== undefined) {
    memory.db
      .prepare(
        "UPDATE memory_items SET last_reinforced_at = MAX(last_reinforced_at, ?), importance = MAX(importance, ?) WHERE id = ?",
      )
      .run(now, input.importance, duplicate);
    return { id: duplicate, reinforced: true };
  }
  const result = memory.db
    .prepare(
      `INSERT INTO memory_items (kind, category, text, importance, status, source_checkpoint_id, created_at, last_reinforced_at, origin, content_hash)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.kind,
      input.category ?? null,
      input.text,
      input.importance,
      input.sourceCheckpointId ?? null,
      now,
      now,
      input.origin,
      hash,
    );
  const id = Number(result.lastInsertRowid);
  if (input.supersedes !== undefined) {
    memory.db
      .prepare("UPDATE memory_items SET status = 'superseded', superseded_by = ? WHERE id = ? AND status = 'active'")
      .run(id, input.supersedes);
  }
  return { id, reinforced: false };
}
