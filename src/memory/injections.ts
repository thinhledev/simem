import type { MemoryDb } from "./db.js";

// Per-session record of what memory was already put in front of the agent,
// so the same item is never injected twice into one context window. Cleared
// when the context is lost (compaction, /clear).

export function recordInjections(memory: MemoryDb, sessionKey: string, refs: string[]): void {
  if (refs.length === 0) return;
  try {
    const insert = memory.db.prepare("INSERT OR IGNORE INTO injections (session_id, ref, ts) VALUES (?, ?, ?)");
    const now = new Date().toISOString();
    for (const ref of refs) insert.run(sessionKey, ref, now);
  } catch {
    // Dedupe is an optimization; never fail injection over it.
  }
}

export function injectedRefs(memory: MemoryDb, sessionKey: string): Set<string> {
  try {
    const rows = memory.db.prepare("SELECT ref FROM injections WHERE session_id = ?").all(sessionKey) as Array<{ ref: string }>;
    return new Set(rows.map((row) => row.ref));
  } catch {
    return new Set();
  }
}

export function clearInjections(memory: MemoryDb, sessionKey: string): void {
  try {
    memory.db.prepare("DELETE FROM injections WHERE session_id = ?").run(sessionKey);
    memory.db.prepare("DELETE FROM tool_reads WHERE session_id = ?").run(sessionKey);
  } catch {
    // Best-effort.
  }
}
