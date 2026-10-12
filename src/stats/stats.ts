import { readCounters } from "../memory/counters.js";
import type { MemoryDb } from "../memory/db.js";

// What `mixai stats`, the memory_stats tool, the dashboard, the status line,
// and the Stop notice report. Every figure says whether it is measured or
// estimated; tokens are estimated from characters only where the provider
// did not report them.

export const CHARS_PER_TOKEN = 3.6;
export const estTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

export interface UsageRow {
  key: string;
  sessions: number;
  turns: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface XrayRow {
  type: string;
  calls: number;
  /** Estimated tokens these tool results added to the context. */
  tokens: number;
}

export interface SavingsRow {
  mechanism: string;
  events: number;
  /** Tokens kept out of the context when the saving happened (est. from chars). */
  tokens: number;
  measured: boolean;
}

export interface Stats {
  since?: string;
  usage: UsageRow[];
  usageTotal: Omit<UsageRow, "key">;
  xray: XrayRow[];
  savings: SavingsRow[];
  savedTokens: number;
  /** Rough: direct savings × typical later turns that would have re-sent them. Labelled estimate. */
  compoundedTokens: number;
  typicalLaterTurns: number;
  redactions: number;
  guards: Record<string, number>;
  memory: { sessions: number; items: number; summaries: number };
}

// Mechanisms whose figure is an exact before/after measurement.
const MEASURED = new Set(["exec", "code-read", "read-guard", "reread-guard", "disclosure", "compaction", "consolidation-cap", "rollup-cap", "inject-dedupe"]);

export function collectStats(memory: MemoryDb, options: { since?: string; groupBy?: "agent" | "surface" | "day" | "session" } = {}): Stats {
  const since = options.since;
  const groupExpr = {
    agent: "s.agent",
    surface: "s.agent || ' ' || s.surface",
    day: "substr(u.ts, 1, 10)",
    session: "COALESCE(s.title, s.id)",
  }[options.groupBy ?? "surface"];
  const usageWhere = since ? "WHERE u.ts >= ?" : "";
  const usage = memory.db
    .prepare(
      `SELECT ${groupExpr} AS key, COUNT(DISTINCT u.session_id) AS sessions, COUNT(*) AS turns,
              SUM(u.input_tokens) AS input, SUM(u.cache_read_tokens) AS cacheRead,
              SUM(u.cache_write_tokens) AS cacheWrite, SUM(u.output_tokens) AS output
       FROM turn_usage u LEFT JOIN sessions s ON s.id = u.session_id ${usageWhere}
       GROUP BY key ORDER BY input + cacheRead + output DESC LIMIT 30`,
    )
    .all(...(since ? [since] : [])) as unknown as UsageRow[];
  const usageTotal = usage.reduce(
    (total, row) => ({
      sessions: total.sessions + row.sessions,
      turns: total.turns + row.turns,
      input: total.input + row.input,
      cacheRead: total.cacheRead + row.cacheRead,
      cacheWrite: total.cacheWrite + row.cacheWrite,
      output: total.output + row.output,
    }),
    { sessions: 0, turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );
  const eventWhere = since ? "WHERE ts >= ?" : "";
  const xray = (
    memory.db
      .prepare(`SELECT type, COUNT(*) AS calls, COALESCE(SUM(bytes), 0) AS bytes FROM events ${eventWhere} GROUP BY type ORDER BY bytes DESC`)
      .all(...(since ? [since] : [])) as Array<{ type: string; calls: number; bytes: number }>
  ).map((row) => ({ type: row.type, calls: row.calls, tokens: estTokens(row.bytes) }));
  const injectChars = (memory.db.prepare(`SELECT COALESCE(SUM(output_chars), 0) AS n, COUNT(*) AS calls FROM llm_calls WHERE purpose = 'inject' ${since ? "AND created_at >= ?" : ""}`).get(...(since ? [since] : [])) as {
    n: number;
    calls: number;
  });
  if (injectChars.calls > 0) xray.push({ type: "memory (mixai)", calls: injectChars.calls, tokens: estTokens(injectChars.n) });
  const savings = (
    memory.db
      .prepare(
        `SELECT mechanism, COUNT(*) AS events, COALESCE(SUM(chars_full - chars_sent), 0) AS chars FROM savings_events
         ${since ? "WHERE created_at >= ?" : ""} GROUP BY mechanism ORDER BY chars DESC`,
      )
      .all(...(since ? [since] : [])) as Array<{ mechanism: string; events: number; chars: number }>
  ).map((row) => ({ mechanism: row.mechanism, events: row.events, tokens: estTokens(row.chars), measured: MEASURED.has(row.mechanism) }));
  const savedTokens = savings.reduce((sum, row) => sum + row.tokens, 0);
  // Content kept out of a context would otherwise be re-sent as cached input
  // on every later turn. Typical later turns ≈ half a session's turns.
  const turnsPerSession = usageTotal.sessions > 0 ? usageTotal.turns / usageTotal.sessions : 0;
  const typicalLaterTurns = Math.max(1, Math.round(turnsPerSession / 2));
  const counters = readCounters(memory);
  const redactions = Object.entries(counters)
    .filter(([key]) => key.startsWith("redact:"))
    .reduce((sum, [, value]) => sum + value, 0);
  const guards = Object.fromEntries(Object.entries(counters).filter(([key]) => key.startsWith("guard:")).map(([key, value]) => [key.slice(6), value]));
  const count = (sql: string) => (memory.db.prepare(sql).get() as { n: number }).n;
  return {
    ...(since ? { since } : {}),
    usage,
    usageTotal,
    xray,
    savings,
    savedTokens,
    compoundedTokens: savedTokens * typicalLaterTurns,
    typicalLaterTurns,
    redactions,
    guards,
    memory: {
      sessions: count("SELECT COUNT(*) AS n FROM sessions"),
      items: count("SELECT COUNT(*) AS n FROM memory_items WHERE status = 'active'"),
      summaries: count("SELECT COUNT(*) AS n FROM summaries WHERE superseded_by IS NULL"),
    },
  };
}

const MECHANISM_LABEL: Record<string, string> = {
  exec: "command output filtered (mixai exec)",
  "code-read": "code_read instead of whole files",
  "code-search": "code_search instead of reading files (estimate)",
  "read-guard": "outline instead of a large full read",
  "reread-guard": "unchanged re-reads skipped",
  disclosure: "memory previews instead of full text",
  compaction: "old summaries merged",
  "consolidation-cap": "consolidation prompt capped",
  "rollup-cap": "rollup prompt capped",
  "inject-dedupe": "memory not re-injected",
};

function n(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatStats(stats: Stats, projectName: string): string {
  const lines: string[] = [`mixai stats — ${projectName}${stats.since ? ` since ${stats.since.slice(0, 10)}` : ""}`, ""];
  const t = stats.usageTotal;
  lines.push("Provider usage (measured, from your agents' transcripts):");
  if (stats.usage.length === 0) lines.push("  none captured yet — run `mixai sync`");
  for (const row of stats.usage) {
    lines.push(`  ${row.key.padEnd(28)} ${String(row.sessions).padStart(4)} sessions  in ${n(row.input).padStart(6)}  cache-read ${n(row.cacheRead).padStart(6)}  cache-write ${n(row.cacheWrite).padStart(6)}  out ${n(row.output).padStart(6)}`);
  }
  if (stats.usage.length > 1) lines.push(`  ${"total".padEnd(28)} ${String(t.sessions).padStart(4)} sessions  in ${n(t.input).padStart(6)}  cache-read ${n(t.cacheRead).padStart(6)}  cache-write ${n(t.cacheWrite).padStart(6)}  out ${n(t.output).padStart(6)}`);
  lines.push("", "What filled the context (estimated from tool result sizes):");
  for (const row of stats.xray.slice(0, 8)) lines.push(`  ${row.type.padEnd(16)} ${String(row.calls).padStart(6)} calls  ~${n(row.tokens)} tokens`);
  lines.push("", "Saved by mixai:");
  if (stats.savings.length === 0) lines.push("  nothing measured yet");
  for (const row of stats.savings) lines.push(`  ~${n(row.tokens).padStart(6)} tokens  ${MECHANISM_LABEL[row.mechanism] ?? row.mechanism} (${row.events}×)`);
  if (stats.savedTokens > 0) {
    lines.push(
      `  = ~${n(stats.savedTokens)} tokens kept out of context (measured from chars)`,
      `  ≈ ~${n(stats.compoundedTokens)} tokens of re-sent context avoided (estimate: × ${stats.typicalLaterTurns} typical later turns)`,
    );
  }
  lines.push("", `Memory: ${stats.memory.sessions} sessions, ${stats.memory.items} active items, ${stats.memory.summaries} summaries · secrets redacted: ${stats.redactions}`);
  const guardEntries = Object.entries(stats.guards);
  if (guardEntries.length) lines.push(`Guards fired: ${guardEntries.map(([key, value]) => `${key} ${value}`).join(", ")}`);
  return lines.join("\n");
}
