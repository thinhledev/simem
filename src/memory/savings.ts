import type { MemoryDb } from "./db.js";

// Every mechanism simem actually compresses, each measured at the moment the
// saving happens — never inferred or modeled. There is deliberately no
// "vs not using simem" mechanism: that would require knowing what a
// from-scratch agent spends re-exploring the repo, which simem cannot observe.
export type SavingsMechanism =
  | "compaction" // superseded per-checkpoint/epoch summaries vs their merged digest
  | "disclosure" // full hit text vs the preview actually returned by memory_search
  | "consolidation-cap" // active memory_items sent in the consolidation prompt vs all active items
  | "rollup-cap" // per-summary text as sent into a rollup prompt vs its raw length
  | "code-search" // estimate: files behind the top hits vs the hit list returned
  | "code-read" // whole file vs the symbol/range returned
  | "exec" // raw command output vs the filtered output returned
  | "read-guard" // whole file a full read would have returned vs the outline given instead
  | "reread-guard" // unchanged file re-read that was blocked
  | "inject-dedupe"; // memory not re-injected because the context already held it

export interface SavingsEntry {
  mechanism: SavingsMechanism;
  /** What would have been sent/kept without simem's compression. */
  charsFull: number;
  /** What was actually sent/kept. */
  charsSent: number;
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

// Best-effort, mirrors ledger.ts: a savings-recording failure must never
// break the compaction/search/consolidation call that triggered it. Rows
// where nothing was actually saved are skipped rather than logged as zero.
export function recordSavings(memory: MemoryDb, entry: SavingsEntry): void {
  const charsSaved = entry.charsFull - entry.charsSent;
  if (charsSaved <= 0) return;
  try {
    memory.db
      .prepare("INSERT INTO savings_events (mechanism, chars_full, chars_sent, created_at) VALUES (?, ?, ?, ?)")
      .run(entry.mechanism, entry.charsFull, entry.charsSent, new Date().toISOString());
  } catch {
    // Savings tracking is additive; never let accounting failures affect the caller.
  }
}

export interface SavingsRow {
  mechanism: string;
  events: number;
  charsSaved: number;
  estimatedTokensSaved: number;
}

export function savingsSummary(memory: MemoryDb): SavingsRow[] {
  const rows = memory.db
    .prepare(
      `SELECT mechanism, COUNT(*) AS events, COALESCE(SUM(chars_full - chars_sent), 0) AS chars_saved
       FROM savings_events GROUP BY mechanism ORDER BY chars_saved DESC`,
    )
    .all() as Array<{ mechanism: string; events: number; chars_saved: number }>;
  return rows.map((row) => ({
    mechanism: row.mechanism,
    events: row.events,
    charsSaved: row.chars_saved,
    estimatedTokensSaved: Math.round(row.chars_saved / CHARS_PER_TOKEN_ESTIMATE),
  }));
}

export interface SavingsTotals {
  events: number;
  charsSaved: number;
  estimatedTokensSaved: number;
}

export function savingsTotals(memory: MemoryDb): SavingsTotals {
  const row = memory.db
    .prepare("SELECT COUNT(*) AS events, COALESCE(SUM(chars_full - chars_sent), 0) AS chars_saved FROM savings_events")
    .get() as { events: number; chars_saved: number };
  return {
    events: row.events,
    charsSaved: row.chars_saved,
    estimatedTokensSaved: Math.round(row.chars_saved / CHARS_PER_TOKEN_ESTIMATE),
  };
}
