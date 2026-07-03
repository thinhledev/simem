import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type MemoryConfig } from "../src/config.js";
import { runCompaction } from "../src/memory/compaction.js";
import type { ConsolidationRunner } from "../src/memory/consolidate.js";
import { loadSqlite, openMemoryDb, type MemoryDb } from "../src/memory/db.js";
import type { GatewayRunResult } from "../src/types.js";

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

function seedCheckpointWithSummary(
  memory: MemoryDb,
  id: string,
  createdAt: string,
  importantText?: string,
): void {
  memory.db
    .prepare(
      "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
        "VALUES (?, ?, '/tmp/w', 'codex', 's', 'switch', 'dir', '{}')",
    )
    .run(id, createdAt);
  memory.db
    .prepare(
      "INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at) VALUES (1, ?, ?, ?, 1, ?)",
    )
    .run(`summary for ${id}`, id, id, createdAt);
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
