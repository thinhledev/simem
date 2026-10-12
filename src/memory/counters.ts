import type { MemoryDb } from "./db.js";

// Small monotonic counters (redactions by kind, guard firings, ...) for
// `mixai stats`. Best-effort: never let accounting break the caller.
export function incrementCounter(memory: MemoryDb, key: string, by = 1): void {
  if (by <= 0) return;
  try {
    memory.db
      .prepare("INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value")
      .run(key, by);
  } catch {
    // Counters are additive diagnostics.
  }
}

export function recordRedactions(memory: MemoryDb, redactions: Record<string, number>): void {
  for (const [kind, count] of Object.entries(redactions)) incrementCounter(memory, `redact:${kind}`, count);
}

export function readCounters(memory: MemoryDb, prefix = ""): Record<string, number> {
  try {
    const rows = memory.db.prepare("SELECT key, value FROM counters WHERE key LIKE ? ORDER BY key").all(`${prefix}%`) as Array<{
      key: string;
      value: number;
    }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } catch {
    return {};
  }
}
