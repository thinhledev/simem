import type { GatewayRunResult, ProviderId, ProviderUsage } from "../types.js";
import type { MemoryDb } from "./db.js";

export type LedgerPurpose = "consolidate" | "rollup-epoch" | "rollup-project" | "run";

export interface LedgerEntry {
  purpose: LedgerPurpose;
  provider: ProviderId;
  checkpointId?: string;
  sessionId?: string;
  promptChars: number;
  outputChars: number;
  usage?: ProviderUsage;
  durationMs: number;
  ok: boolean;
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

// Best-effort: a ledger write failing must never break the caller's actual
// work (consolidation/rollup/run already succeeded or failed on its own).
export function recordLlmCall(memory: MemoryDb, entry: LedgerEntry): void {
  try {
    const measured = entry.usage?.inputTokens !== undefined || entry.usage?.outputTokens !== undefined;
    const inputTokens = entry.usage?.inputTokens ?? Math.ceil(entry.promptChars / CHARS_PER_TOKEN_ESTIMATE);
    const outputTokens = entry.usage?.outputTokens ?? Math.ceil(entry.outputChars / CHARS_PER_TOKEN_ESTIMATE);
    memory.db
      .prepare(
        `INSERT INTO llm_calls (
          purpose, provider, checkpoint_id, session_id, prompt_chars, output_chars,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
          estimated, duration_ms, ok, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.purpose,
        entry.provider,
        entry.checkpointId ?? null,
        entry.sessionId ?? null,
        entry.promptChars,
        entry.outputChars,
        inputTokens,
        outputTokens,
        entry.usage?.cacheReadTokens ?? null,
        entry.usage?.cacheCreationTokens ?? null,
        entry.usage?.costUsd ?? null,
        measured ? 0 : 1,
        entry.durationMs,
        entry.ok ? 1 : 0,
        new Date().toISOString(),
      );
  } catch {
    // Ledger is additive; never let accounting failures affect the caller.
  }
}

// Records one ledger row per attempt in a GatewayRunResult — including
// failed attempts before a successful fallback, since a failed API call
// still spent tokens. `result.attempts` is empty when no provider was ready
// at all, in which case there's nothing to bill.
export function recordGatewayAttempts(
  memory: MemoryDb,
  purpose: LedgerPurpose,
  checkpointId: string | undefined,
  promptChars: number,
  result: GatewayRunResult,
): void {
  for (const attempt of result.attempts) {
    recordLlmCall(memory, {
      purpose,
      provider: attempt.provider,
      ...(checkpointId ? { checkpointId } : {}),
      ...(attempt.result.sessionId ? { sessionId: attempt.result.sessionId } : {}),
      promptChars,
      outputChars: attempt.result.output.length,
      ...(attempt.result.usage ? { usage: attempt.result.usage } : {}),
      durationMs: attempt.result.durationMs,
      ok: attempt.result.ok,
    });
  }
}

export interface SpendRow {
  group: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimatedCalls: number;
}

const GROUP_EXPR: Record<"purpose" | "provider" | "day", string> = {
  purpose: "purpose",
  provider: "provider",
  day: "date(created_at)",
};

export function spendSummary(memory: MemoryDb, groupBy: "purpose" | "provider" | "day" = "purpose"): SpendRow[] {
  const expr = GROUP_EXPR[groupBy];
  const rows = memory.db
    .prepare(
      `SELECT ${expr} AS group_key,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd,
              COALESCE(SUM(estimated), 0) AS estimated_calls
       FROM llm_calls
       GROUP BY ${expr}
       ORDER BY calls DESC`,
    )
    .all() as Array<{
    group_key: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    estimated_calls: number;
  }>;
  return rows.map((row) => ({
    group: row.group_key,
    calls: row.calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    estimatedCalls: row.estimated_calls,
  }));
}

export interface SpendTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimatedCalls: number;
}

export function spendTotals(memory: MemoryDb): SpendTotals {
  const row = memory.db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd,
              COALESCE(SUM(estimated), 0) AS estimated_calls
       FROM llm_calls`,
    )
    .get() as {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    estimated_calls: number;
  };
  return {
    calls: row.calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    estimatedCalls: row.estimated_calls,
  };
}
