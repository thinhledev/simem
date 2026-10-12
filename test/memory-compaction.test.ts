import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type MemoryConfig } from "../src/config.js";
import { extractiveDigest, runCompaction } from "../src/memory/compaction.js";
import type { ConsolidationRunner } from "../src/memory/consolidate.js";
import { loadSqlite, openMemoryDb, type MemoryDb } from "../src/memory/db.js";
import type { GatewayRunResult, RunRequest } from "../src/types.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

const smallConfig: MemoryConfig = {
  ...DEFAULT_CONFIG.memory,
  verbatimCheckpoints: 2,
  epochSize: 3,
  projectDigestEpochs: 2,
};

function runnerEcho(text: string): ConsolidationRunner & { calls: number } {
  const fake = {
    calls: 0,
    async run(): Promise<GatewayRunResult> {
      fake.calls += 1;
      return {
        runId: "r",
        ok: true,
        attempts: [],
        result: { provider: "claude", ok: true, output: text, events: [], durationMs: 1, exitCode: 0 },
      };
    },
  };
  return fake;
}

function capturingRunnerEcho(text: string): ConsolidationRunner & { prompts: string[] } {
  const fake = {
    prompts: [] as string[],
    async run(request: RunRequest): Promise<GatewayRunResult> {
      fake.prompts.push(request.prompt);
      return {
        runId: "r",
        ok: true,
        attempts: [],
        result: { provider: "claude", ok: true, output: text, events: [], durationMs: 1, exitCode: 0 },
      };
    },
  };
  return fake;
}

function seedCheckpointWithSummary(
  memory: MemoryDb,
  id: string,
  createdAt: string,
  importantText?: string,
  summaryText?: string,
  milestone = false,
): void {
  memory.db
    .prepare(
      "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
        "VALUES (?, ?, '/tmp/w', 'codex', 's', 'switch', 'dir', '{}')",
    )
    .run(id, createdAt);
  memory.db
    .prepare(
      "INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at, milestone) VALUES (1, ?, ?, ?, 1, ?, ?)",
    )
    .run(summaryText ?? `summary for ${id}`, id, id, createdAt, milestone ? 1 : 0);
  if (importantText) {
    memory.db
      .prepare(
        "INSERT INTO memory_items (kind, category, text, importance, status, source_checkpoint_id, created_at, last_reinforced_at) " +
          "VALUES ('semantic', 'constraint', ?, 9, 'active', ?, ?, ?)",
      )
      .run(importantText, id, createdAt, createdAt);
  }
}

test("rolls up L1 summaries into one L2 epoch digest once the threshold is exceeded, keeps verbatim window untouched", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    // 5 checkpoints total; verbatimCheckpoints=2 keeps the newest 2 out of compaction,
    // leaving 3 eligible L1s == epochSize, so exactly one epoch digest should form.
    for (let i = 1; i <= 5; i += 1) {
      seedCheckpointWithSummary(memory, `cp-${i}`, `2026-07-0${i}T00:00:00Z`, i === 1 ? "never use dependency X" : undefined);
    }
    const runner = runnerEcho("Consolidated epoch digest covering cp-1..cp-3.");
    const result = await runCompaction(memory, runner, smallConfig);
    assert.equal(result.epochDigests, 1);
    assert.equal(result.projectDigests, 0);

    const l1Active = memory.db.prepare("SELECT COUNT(*) AS n FROM summaries WHERE level = 1 AND superseded_by IS NULL").get() as {
      n: number;
    };
    // 2 verbatim L1s remain active/uncompacted; the 3 older ones are superseded but still present.
    assert.equal(l1Active.n, 2);
    const l1Total = memory.db.prepare("SELECT COUNT(*) AS n FROM summaries WHERE level = 1").get() as { n: number };
    assert.equal(l1Total.n, 5, "superseded L1 rows must be kept, not deleted");
    const l2 = memory.db.prepare("SELECT COUNT(*) AS n FROM summaries WHERE level = 2").get() as { n: number };
    assert.equal(l2.n, 1);

    const savings = memory.db
      .prepare("SELECT mechanism, chars_full, chars_sent FROM savings_events WHERE mechanism = 'compaction'")
      .get() as { mechanism: string; chars_full: number; chars_sent: number } | undefined;
    assert.ok(savings, "compaction should record a savings event");
    assert.ok(savings.chars_full > savings.chars_sent, "raw summary text should exceed the digest length");
  } finally {
    memory.close();
  }
});

test("memory_items are never touched by compaction regardless of age", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    for (let i = 1; i <= 5; i += 1) {
      seedCheckpointWithSummary(memory, `cp-${i}`, `2026-07-0${i}T00:00:00Z`, i === 1 ? "never use dependency X" : undefined);
    }
    const runner = runnerEcho("digest");
    await runCompaction(memory, runner, smallConfig);
    const item = memory.db.prepare("SELECT status FROM memory_items WHERE text = 'never use dependency X'").get() as {
      status: string;
    };
    assert.equal(item.status, "active");
  } finally {
    memory.close();
  }
});

test("epoch digests roll up into a project digest once enough epochs accumulate", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    // 8 checkpoints, verbatimCheckpoints=2 -> 6 eligible L1s / epochSize=3 -> 2 epoch digests -> projectDigestEpochs=2 triggers one project digest.
    for (let i = 1; i <= 8; i += 1) {
      seedCheckpointWithSummary(memory, `cp-${i}`, `2026-07-${String(i).padStart(2, "0")}T00:00:00Z`);
    }
    const runner = runnerEcho("digest text");
    const result = await runCompaction(memory, runner, smallConfig);
    assert.equal(result.epochDigests, 2);
    assert.equal(result.projectDigests, 1);
    const l3 = memory.db.prepare("SELECT COUNT(*) AS n FROM summaries WHERE level = 3").get() as { n: number };
    assert.equal(l3.n, 1);
    const l2Active = memory.db.prepare("SELECT COUNT(*) AS n FROM summaries WHERE level = 2 AND superseded_by IS NULL").get() as {
      n: number;
    };
    assert.equal(l2Active.n, 0, "both epoch digests should be folded into the project digest");
  } finally {
    memory.close();
  }
});

test("caps each summary's text in the rollup prompt to rollupSummaryCharCap", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const longSummary = "detail ".repeat(500); // ~3500 chars, well over a 100-char test cap
    for (let i = 1; i <= 5; i += 1) {
      seedCheckpointWithSummary(memory, `cp-${i}`, `2026-07-0${i}T00:00:00Z`, undefined, longSummary);
    }
    const tightConfig: MemoryConfig = { ...smallConfig, rollupSummaryCharCap: 100 };
    const runner = capturingRunnerEcho("digest");
    await runCompaction(memory, runner, tightConfig);

    const prompt = runner.prompts[0] ?? "";
    const blocks = prompt.split(/--- \d+ /).slice(1);
    assert.equal(blocks.length, 3, "epochSize=3 summaries should appear in the prompt");
    for (const block of blocks) {
      const text = block.split(" ---\n")[1]?.trim() ?? "";
      assert.ok(text.length <= 101, `summary block too long: ${text.length}`);
    }

    const savings = memory.db
      .prepare("SELECT chars_full, chars_sent FROM savings_events WHERE mechanism = 'rollup-cap'")
      .get() as { chars_full: number; chars_sent: number } | undefined;
    assert.ok(savings, "the per-summary cap should record a rollup-cap savings event");
    assert.ok(savings.chars_full > savings.chars_sent);
  } finally {
    memory.close();
  }
});

test("the rollup instruction prefix is byte-identical across epoch and project rollups", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    for (let i = 1; i <= 8; i += 1) {
      seedCheckpointWithSummary(memory, `cp-${i}`, `2026-07-${String(i).padStart(2, "0")}T00:00:00Z`);
    }
    const runner = capturingRunnerEcho("digest");
    await runCompaction(memory, runner, smallConfig);

    assert.ok(runner.prompts.length >= 3, "expect 2 epoch rollups + 1 project rollup");
    const stableLine = "You are compacting the long-term memory of a coding project. Merge the following summaries into ONE digest.";
    for (const prompt of runner.prompts) {
      assert.ok(prompt.startsWith(stableLine), "every rollup prompt must share the same stable opening");
    }
    // The variable clause (count/label/word cap) differs between epoch and project rollups.
    assert.match(runner.prompts[0] ?? "", /Merging \d+ chronological checkpoint summaries/);
    assert.match(runner.prompts.at(-1) ?? "", /Merging \d+ epoch digests/);
  } finally {
    memory.close();
  }
});

test("annotates milestone summaries with [MILESTONE] in the rollup prompt", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    // verbatimCheckpoints=2 keeps the newest 2 out of compaction; need 5
    // checkpoints so exactly epochSize=3 are eligible and a rollup fires.
    seedCheckpointWithSummary(memory, "cp-1", "2026-07-01T00:00:00Z", undefined, "Shipped the new auth flow.", true);
    seedCheckpointWithSummary(memory, "cp-2", "2026-07-02T00:00:00Z", undefined, "Routine progress on tests.");
    seedCheckpointWithSummary(memory, "cp-3", "2026-07-03T00:00:00Z", undefined, "More routine progress.");
    seedCheckpointWithSummary(memory, "cp-4", "2026-07-04T00:00:00Z", undefined, "Verbatim window filler A.");
    seedCheckpointWithSummary(memory, "cp-5", "2026-07-05T00:00:00Z", undefined, "Verbatim window filler B.");
    const runner = capturingRunnerEcho("digest");
    await runCompaction(memory, runner, smallConfig);

    const prompt = runner.prompts[0] ?? "";
    assert.match(prompt, /\[MILESTONE\] Shipped the new auth flow\./);
    assert.doesNotMatch(prompt, /\[MILESTONE\] Routine progress/);
    assert.match(prompt, /weight them more heavily/);
  } finally {
    memory.close();
  }
});

test("does not create an epoch digest below the threshold", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    for (let i = 1; i <= 3; i += 1) seedCheckpointWithSummary(memory, `cp-${i}`, `2026-07-0${i}T00:00:00Z`);
    const runner = runnerEcho("digest");
    const result = await runCompaction(memory, runner, smallConfig);
    assert.equal(result.epochDigests, 0);
    assert.equal(runner.calls, 0);
  } finally {
    memory.close();
  }
});

test("with no LLM tier, rollups use the extractive digest and spend nothing", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    for (let i = 1; i <= 5; i += 1) {
      seedCheckpointWithSummary(
        memory,
        `cp-${i}`,
        `2026-07-0${i}T00:00:00Z`,
        i === 1 ? "Never use dependency X." : undefined,
        `Objective: task ${i}.\nOutcome: finished task ${i}.`,
        i === 2,
      );
    }
    const result = await runCompaction(memory, undefined, smallConfig);
    assert.equal(result.epochDigests, 1);
    const digest = memory.db.prepare("SELECT text FROM summaries WHERE level = 2").get() as { text: string };
    assert.match(digest.text, /^- Objective: task 1\. Outcome: finished task 1\./);
    assert.match(digest.text, /- \[MILESTONE\] Objective: task 2\./);
    assert.match(digest.text, /Standing constraints:\n- Never use dependency X\./);
    const calls = memory.db.prepare("SELECT COUNT(*) AS n FROM llm_calls").get() as { n: number };
    assert.equal(calls.n, 0);
  } finally {
    memory.close();
  }
});

test("a failing LLM tier falls back to the extractive digest instead of stalling compaction", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    for (let i = 1; i <= 5; i += 1) seedCheckpointWithSummary(memory, `cp-${i}`, `2026-07-0${i}T00:00:00Z`);
    const failing: ConsolidationRunner = { run: async () => ({ runId: "r", ok: false, attempts: [] }) };
    const result = await runCompaction(memory, failing, smallConfig);
    assert.equal(result.epochDigests, 1);
    assert.equal(result.detail, undefined);
  } finally {
    memory.close();
  }
});

test("extractiveDigest stays within the digest budget for long inputs", () => {
  const summaries = Array.from({ length: 40 }, (_, index) => ({
    id: index,
    text: `Objective: ${"long detail ".repeat(60)}`,
    covers_from: `cp-${index}`,
    covers_to: `cp-${index}`,
    checkpoint_count: 1,
    milestone: 0,
  }));
  const digest = extractiveDigest("epoch", summaries, [], 1_200);
  assert.ok(digest.length <= 250 * 8 + 1);
});
