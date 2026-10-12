import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import { selectDistillRunner } from "../src/memory/distill/runner.js";
import { contentHash, upsertMemoryItem } from "../src/memory/items.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

test("contentHash ignores case, punctuation, backticks, and whitespace", () => {
  assert.equal(contentHash("Never use `npm`  here."), contentHash("never use npm here"));
  assert.notEqual(contentHash("Never use npm here."), contentHash("Always use npm here."));
});

test("restating a fact reinforces the existing row instead of duplicating it", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const base = { kind: "semantic" as const, category: "constraint" as const, origin: "rule" as const };
    const first = upsertMemoryItem(memory, { ...base, text: "Never commit directly to master.", importance: 7 }, "2026-07-01T00:00:00Z");
    const exact = upsertMemoryItem(memory, { ...base, text: "never commit directly to `master`", importance: 9 }, "2026-08-01T00:00:00Z");
    assert.deepEqual(exact, { id: first.id, reinforced: true });
    const row = memory.db.prepare("SELECT importance, last_reinforced_at FROM memory_items WHERE id = ?").get(first.id) as {
      importance: number;
      last_reinforced_at: string;
    };
    assert.equal(row.importance, 9, "keeps the higher importance");
    assert.equal(row.last_reinforced_at, "2026-08-01T00:00:00Z");

    const near = upsertMemoryItem(memory, { ...base, text: "Never commit directly to master, ever.", importance: 7 });
    assert.equal(near.reinforced, true, "a near-identical restatement (>= 80% word overlap) of the same category merges");

    const otherCategory = upsertMemoryItem(memory, {
      ...base,
      category: "preference",
      text: "Never commit directly to master.",
      importance: 7,
    });
    assert.equal(otherCategory.reinforced, true, "an exact restatement merges whatever its category");

    const different = upsertMemoryItem(memory, { ...base, text: "Never force-push to release branches.", importance: 8 });
    assert.equal(different.reinforced, false);
    const count = memory.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number };
    assert.equal(count.n, 2);
  } finally {
    memory.close();
  }
});

test("supersedes marks the replaced item and records provenance", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const old = upsertMemoryItem(memory, { kind: "semantic", category: "decision", text: "Use npm for installs.", importance: 6, origin: "rule" });
    const replacement = upsertMemoryItem(memory, {
      kind: "semantic",
      category: "decision",
      text: "Use pnpm for installs in this workspace.",
      importance: 8,
      origin: "llm",
      supersedes: old.id,
    });
    const rows = memory.db.prepare("SELECT id, status, superseded_by, origin FROM memory_items ORDER BY id").all() as Array<{
      id: number;
      status: string;
      superseded_by: number | null;
      origin: string;
    }>;
    assert.deepEqual({ ...rows[0] }, { id: old.id, status: "superseded", superseded_by: replacement.id, origin: "rule" });
    assert.equal(rows[1]?.origin, "llm");
  } finally {
    memory.close();
  }
});

test("selectDistillRunner: rules only by default, remote only when opted in, local only when Ollama has the model", async () => {
  let remoteBuilt = 0;
  const remote = () => {
    remoteBuilt += 1;
    return { run: async () => ({ runId: "r", ok: false, attempts: [] }) };
  };
  assert.equal(await selectDistillRunner(DEFAULT_CONFIG.memory, remote), undefined);
  assert.equal(remoteBuilt, 0, "the default config must not even construct the remote runner");

  const optedIn = await selectDistillRunner({ ...DEFAULT_CONFIG.memory, distill: { remote: true, ollamaModel: "" } }, remote);
  assert.ok(optedIn);
  assert.equal(remoteBuilt, 1);

  const unreachable = await selectDistillRunner(
    {
      ...DEFAULT_CONFIG.memory,
      embeddings: { ...DEFAULT_CONFIG.memory.embeddings, ollamaUrl: "http://127.0.0.1:9" },
      distill: { remote: false, ollamaModel: "qwen2.5:3b" },
    },
    remote,
  );
  assert.equal(unreachable, undefined, "a missing Ollama degrades to rules only");
});

test("reinforcing with an older statement never moves last_reinforced_at backwards", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const input = { kind: "semantic" as const, category: "constraint" as const, origin: "rule" as const, importance: 8 };
    const { id } = upsertMemoryItem(memory, { ...input, text: "Never log raw tokens." }, "2026-09-01T00:00:00Z");
    upsertMemoryItem(memory, { ...input, text: "Never log raw tokens." }, "2026-07-01T00:00:00Z");
    const row = memory.db.prepare("SELECT created_at, last_reinforced_at FROM memory_items WHERE id = ?").get(id) as {
      created_at: string;
      last_reinforced_at: string;
    };
    assert.equal(row.last_reinforced_at, "2026-09-01T00:00:00Z");
    assert.equal(row.created_at, "2026-09-01T00:00:00Z");
  } finally {
    memory.close();
  }
});
