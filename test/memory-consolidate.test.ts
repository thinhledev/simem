import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type MemoryConfig } from "../src/config.js";
import {
  consolidateCheckpoint,
  drainConsolidationQueue,
  parseConsolidationOutput,
  type ConsolidationRunner,
} from "../src/memory/consolidate.js";
import { loadSqlite, openMemoryDb, type MemoryDb } from "../src/memory/db.js";
import type { GatewayRunResult, RunRequest } from "../src/types.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };
const memoryConfig: MemoryConfig = DEFAULT_CONFIG.memory;

function okResult(output: string): GatewayRunResult {
  return {
    runId: "run-1",
    ok: true,
    attempts: [],
    result: {
      provider: "claude",
      ok: true,
      output,
      events: [],
      durationMs: 5,
      exitCode: 0,
    },
  };
}

function runnerReturning(results: GatewayRunResult[]): ConsolidationRunner & { calls: number } {
  const fake = {
    calls: 0,
    async run(): Promise<GatewayRunResult> {
      const result = results[Math.min(fake.calls, results.length - 1)];
      fake.calls += 1;
      if (!result) throw new Error("no canned result");
      return result;
    },
  };
  return fake;
}

function capturingRunner(output: string): ConsolidationRunner & { prompts: string[] } {
  const fake = {
    prompts: [] as string[],
    async run(request: RunRequest): Promise<GatewayRunResult> {
      fake.prompts.push(request.prompt);
      return okResult(output);
    },
  };
  return fake;
}

function seedCheckpoint(memory: MemoryDb, id: string): void {
  memory.db
    .prepare(
      "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
        "VALUES (?, '2026-07-03T00:00:00Z', '/tmp/w', 'codex', 's', 'switch', 'dir', '{}')",
    )
    .run(id);
  memory.db
    .prepare("INSERT INTO messages (checkpoint_id, seq, role, text) VALUES (?, 0, 'user', 'never use dependency X, it is banned')")
    .run(id);
}

test("parses fenced and noisy JSON output tolerantly", () => {
  const clean = parseConsolidationOutput('{"summary":"s","items":[]}', new Set());
  assert.equal(clean?.summary, "s");
  const fenced = parseConsolidationOutput('Here you go:\n```json\n{"summary":"f","items":[]}\n```\nDone.', new Set());
  assert.equal(fenced?.summary, "f");
  const invalid = parseConsolidationOutput("I cannot help with that.", new Set());
  assert.equal(invalid, undefined);
  // Items with invalid kinds/importance are dropped, not fatal.
  const partial = parseConsolidationOutput(
    JSON.stringify({
      summary: "p",
      items: [
        { kind: "semantic", category: "constraint", text: "never use dependency X", importance: 9 },
        { kind: "bogus", text: "x", importance: 5 },
        { kind: "episodic", text: "", importance: 5 },
        { kind: "episodic", text: "importance out of range", importance: 15 },
      ],
    }),
    new Set(),
  );
  assert.equal(partial?.items.length, 1);
  assert.equal(partial?.items[0]?.importance, 9);
});

test("parses milestone flag, defaulting to false when absent or not exactly true", () => {
  const flagged = parseConsolidationOutput('{"summary":"s","milestone":true,"items":[]}', new Set());
  assert.equal(flagged?.milestone, true);
  const absent = parseConsolidationOutput('{"summary":"s","items":[]}', new Set());
  assert.equal(absent?.milestone, false);
  const wrongType = parseConsolidationOutput('{"summary":"s","milestone":"true","items":[]}', new Set());
  assert.equal(wrongType?.milestone, false);
});

test("writes summary and items, applies supersession, marks checkpoint done", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-1");
    memory.db
      .prepare(
        "INSERT INTO memory_items (id, kind, text, importance, status, created_at, last_reinforced_at) " +
          "VALUES (42, 'semantic', 'dependency X is allowed', 6, 'active', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
      )
      .run();
    const runner = runnerReturning([
      okResult(
        JSON.stringify({
          summary: "The team banned dependency X after a security review.",
          items: [
            {
              kind: "semantic",
              category: "constraint",
              text: "Dependency X must never be used in this project.",
              importance: 9,
              supersedes: 42,
            },
          ],
        }),
      ),
    ]);
    const result = await consolidateCheckpoint(memory, runner, "cp-1", memoryConfig);
    assert.equal(result.status, "done");
    assert.equal(result.itemsWritten, 1);

    const summary = memory.db.prepare("SELECT level, covers_from FROM summaries").get() as {
      level: number;
      covers_from: string;
    };
    assert.equal(summary.level, 1);
    assert.equal(summary.covers_from, "cp-1");
    const old = memory.db.prepare("SELECT status, superseded_by FROM memory_items WHERE id = 42").get() as {
      status: string;
      superseded_by: number;
    };
    assert.equal(old.status, "superseded");
    assert.ok(old.superseded_by > 0);
    const status = memory.db.prepare("SELECT consolidation_status FROM checkpoints WHERE id = 'cp-1'").get() as {
      consolidation_status: string;
    };
    assert.equal(status.consolidation_status, "done");
    // Idempotent: a second run is a no-op.
    const again = await consolidateCheckpoint(memory, runner, "cp-1", memoryConfig);
    assert.equal(again.detail, "already consolidated");
    assert.equal(runner.calls, 1);
  } finally {
    memory.close();
  }
});

test("persists the milestone flag onto the checkpoint's summary row", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-milestone");
    const runner = runnerReturning([
      okResult(JSON.stringify({ summary: "Shipped the v2 auth flow.", milestone: true, items: [] })),
    ]);
    await consolidateCheckpoint(memory, runner, "cp-milestone", memoryConfig);
    const row = memory.db.prepare("SELECT milestone FROM summaries WHERE covers_from = 'cp-milestone'").get() as {
      milestone: number;
    };
    assert.equal(row.milestone, 1);

    seedCheckpoint(memory, "cp-routine");
    const routineRunner = runnerReturning([okResult('{"summary":"Routine progress.","items":[]}')]);
    await consolidateCheckpoint(memory, routineRunner, "cp-routine", memoryConfig);
    const routineRow = memory.db.prepare("SELECT milestone FROM summaries WHERE covers_from = 'cp-routine'").get() as {
      milestone: number;
    };
    assert.equal(routineRow.milestone, 0);
  } finally {
    memory.close();
  }
});

test("queues on no ready provider and drains later without duplicating", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-q");
    const failing = runnerReturning([{ runId: "r", ok: false, attempts: [] }]);
    const first = await consolidateCheckpoint(memory, failing, "cp-q", memoryConfig);
    assert.equal(first.status, "queued");
    assert.equal(first.detail, "no provider ready");
    const depth = memory.db.prepare("SELECT COUNT(*) AS n FROM consolidation_queue").get() as { n: number };
    assert.equal(depth.n, 1);

    const succeeding = runnerReturning([okResult('{"summary":"recovered","items":[]}')]);
    const drained = await drainConsolidationQueue(memory, succeeding, memoryConfig);
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.status, "done");
    const after = memory.db.prepare("SELECT COUNT(*) AS n FROM consolidation_queue").get() as { n: number };
    assert.equal(after.n, 0);
  } finally {
    memory.close();
  }
});

test("caps EXISTING ITEMS to consolidationExistingItemsLimit and notes how many were omitted", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-cap");
    const insertItem = memory.db.prepare(
      "INSERT INTO memory_items (kind, text, importance, status, created_at, last_reinforced_at) " +
        "VALUES ('semantic', ?, ?, 'active', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
    );
    for (let i = 0; i < 120; i += 1) insertItem.run(`standing fact number ${i}`, (i % 10) + 1);

    const smallLimitConfig: MemoryConfig = { ...memoryConfig, consolidationExistingItemsLimit: 50 };
    const runner = capturingRunner('{"summary":"s","items":[]}');
    await consolidateCheckpoint(memory, runner, "cp-cap", smallLimitConfig);

    const prompt = runner.prompts[0] ?? "";
    const itemLines = prompt.split("\n").filter((line) => /^\d+\. \[semantic/.test(line));
    assert.equal(itemLines.length, 50);
    assert.match(prompt, /\(\+70 older lower-importance items omitted; use memory_search to find them\)/);

    const savings = memory.db
      .prepare("SELECT chars_full, chars_sent FROM savings_events WHERE mechanism = 'consolidation-cap'")
      .get() as { chars_full: number; chars_sent: number } | undefined;
    assert.ok(savings, "the existing-items cap should record a consolidation-cap savings event");
    assert.ok(savings.chars_full > savings.chars_sent);
  } finally {
    memory.close();
  }
});

test("does not print an omitted-items note when everything fits under the cap", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-nocap");
    memory.db
      .prepare(
        "INSERT INTO memory_items (kind, text, importance, status, created_at, last_reinforced_at) " +
          "VALUES ('semantic', 'a small standing fact', 5, 'active', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
      )
      .run();
    const runner = capturingRunner('{"summary":"s","items":[]}');
    await consolidateCheckpoint(memory, runner, "cp-nocap", memoryConfig);
    assert.doesNotMatch(runner.prompts[0] ?? "", /omitted/);
  } finally {
    memory.close();
  }
});

test("consolidation prompt includes the milestone field and rule", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-prompt");
    const runner = capturingRunner('{"summary":"s","milestone":false,"items":[]}');
    await consolidateCheckpoint(memory, runner, "cp-prompt", memoryConfig);
    const prompt = runner.prompts[0] ?? "";
    assert.match(prompt, /"milestone": <true \| false>/);
    assert.match(prompt, /distinct, nameable objective/);
  } finally {
    memory.close();
  }
});

test("malformed model output queues instead of throwing", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-bad");
    const runner = runnerReturning([okResult("Sorry, I refuse to answer in JSON today.")]);
    const result = await consolidateCheckpoint(memory, runner, "cp-bad", memoryConfig);
    assert.equal(result.status, "queued");
    const row = memory.db
      .prepare("SELECT last_error FROM consolidation_queue WHERE checkpoint_id = 'cp-bad'")
      .get() as { last_error: string };
    assert.match(row.last_error, /unparseable/);
  } finally {
    memory.close();
  }
});
