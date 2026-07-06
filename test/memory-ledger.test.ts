import assert from "node:assert/strict";
import test from "node:test";
import { loadSqlite, openMemoryDb, type MemoryDb } from "../src/memory/db.js";
import { recordGatewayAttempts, recordLlmCall, spendSummary, spendTotals } from "../src/memory/ledger.js";
import type { GatewayRunResult, ProviderRunResult } from "../src/types.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

function providerResult(overrides: Partial<ProviderRunResult> = {}): ProviderRunResult {
  return {
    provider: "claude",
    ok: true,
    output: "hello",
    events: [],
    durationMs: 5,
    exitCode: 0,
    ...overrides,
  };
}

function seedCheckpoint(memory: MemoryDb, id: string): void {
  memory.db
    .prepare(
      "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
        "VALUES (?, '2026-07-03T00:00:00Z', '/tmp/w', 'codex', 's', 'export', 'dir', '{}')",
    )
    .run(id);
}

test("recordLlmCall stores exact usage when the provider reports it", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-1");
    recordLlmCall(memory, {
      purpose: "consolidate",
      provider: "claude",
      checkpointId: "cp-1",
      promptChars: 1000,
      outputChars: 200,
      usage: { inputTokens: 250, outputTokens: 50, costUsd: 0.001 },
      durationMs: 12,
      ok: true,
    });
    const row = memory.db.prepare("SELECT * FROM llm_calls").get() as Record<string, unknown>;
    assert.equal(row.purpose, "consolidate");
    assert.equal(row.input_tokens, 250);
    assert.equal(row.output_tokens, 50);
    assert.equal(row.estimated, 0);
    assert.equal(row.cost_usd, 0.001);
    assert.equal(row.prompt_chars, 1000);
  } finally {
    memory.close();
  }
});

test("recordLlmCall estimates tokens from chars and marks the row as estimated when usage is absent", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    recordLlmCall(memory, {
      purpose: "run",
      provider: "cursor",
      promptChars: 400,
      outputChars: 40,
      durationMs: 3,
      ok: true,
    });
    const row = memory.db.prepare("SELECT * FROM llm_calls").get() as Record<string, unknown>;
    assert.equal(row.estimated, 1);
    assert.equal(row.input_tokens, 100); // 400 / 4
    assert.equal(row.output_tokens, 10); // 40 / 4
    assert.equal(row.cost_usd, null);
  } finally {
    memory.close();
  }
});

test("a ledger write failure never throws (best-effort)", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    memory.db.exec("DROP TABLE llm_calls");
    assert.doesNotThrow(() =>
      recordLlmCall(memory, {
        purpose: "run",
        provider: "codex",
        promptChars: 10,
        outputChars: 10,
        durationMs: 1,
        ok: true,
      }),
    );
  } finally {
    memory.close();
  }
});

test("recordGatewayAttempts writes one row per attempt, including failed attempts before a fallback succeeded", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-1");
    const result: GatewayRunResult = {
      runId: "r",
      ok: true,
      attempts: [
        {
          provider: "codex",
          credential: { tier: "unknown", source: "none" },
          result: providerResult({ provider: "codex", ok: false, failure: "quota" }),
        },
        {
          provider: "claude",
          credential: { tier: "paid", source: "ANTHROPIC_API_KEY" },
          result: providerResult({ provider: "claude", ok: true, usage: { inputTokens: 10 } }),
        },
      ],
      result: providerResult({ provider: "claude", ok: true }),
    };
    recordGatewayAttempts(memory, "consolidate", "cp-1", 500, result);
    const rows = (memory.db.prepare("SELECT provider, ok FROM llm_calls ORDER BY id").all() as Array<{
      provider: string;
      ok: number;
    }>).map((row) => ({ provider: row.provider, ok: row.ok }));
    assert.deepEqual(rows, [
      { provider: "codex", ok: 0 },
      { provider: "claude", ok: 1 },
    ]);
  } finally {
    memory.close();
  }
});

test("recordGatewayAttempts writes nothing when no provider was ready (empty attempts)", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    recordGatewayAttempts(memory, "run", undefined, 100, { runId: "r", ok: false, attempts: [] });
    const count = memory.db.prepare("SELECT COUNT(*) AS n FROM llm_calls").get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    memory.close();
  }
});

test("spendSummary groups by purpose/provider/day and spendTotals aggregates everything", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const insert = memory.db.prepare(
      `INSERT INTO llm_calls (purpose, provider, prompt_chars, output_chars, input_tokens, output_tokens, cost_usd, estimated, duration_ms, ok, created_at)
       VALUES (?, ?, 100, 20, ?, ?, ?, ?, 5, 1, ?)`,
    );
    insert.run("consolidate", "claude", 100, 20, 0.01, 0, "2026-07-01T00:00:00Z");
    insert.run("consolidate", "claude", 50, 10, 0.005, 0, "2026-07-01T12:00:00Z");
    insert.run("rollup-epoch", "codex", 30, 5, null, 1, "2026-07-02T00:00:00Z");

    const byPurpose = spendSummary(memory, "purpose");
    const consolidateRow = byPurpose.find((row) => row.group === "consolidate");
    assert.equal(consolidateRow?.calls, 2);
    assert.equal(consolidateRow?.inputTokens, 150);
    assert.ok(Math.abs((consolidateRow?.costUsd ?? 0) - 0.015) < 1e-9);

    const byProvider = spendSummary(memory, "provider");
    assert.equal(byProvider.find((row) => row.group === "codex")?.estimatedCalls, 1);

    const byDay = spendSummary(memory, "day");
    assert.equal(byDay.length, 2);

    const totals = spendTotals(memory);
    assert.equal(totals.calls, 3);
    assert.equal(totals.estimatedCalls, 1);
  } finally {
    memory.close();
  }
});
