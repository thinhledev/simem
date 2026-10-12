import assert from "node:assert/strict";
import test from "node:test";
import { loadSqlite, openMemoryDb, type MemoryDb } from "../src/memory/db.js";
import { toBlob, type EmbeddingClient } from "../src/memory/embeddings.js";
import { AUTOMATIC_INJECTION_GATE, ftsQuery, queryTerms, reciprocalRankFusion, search } from "../src/memory/retrieval.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

test("ftsQuery ORs quoted topic terms so FTS5 syntax in user text is inert", () => {
  assert.equal(ftsQuery("foo-bar()"), '"foo" OR "bar"');
  assert.equal(ftsQuery("TypeError: x is not a function"), '"typeerror" OR "function"');
  assert.equal(ftsQuery('parse "quoted" AND NEAR'), '"parse" OR "quoted" OR "near"');
});

test("queryTerms keeps topic words, splits identifiers like the FTS tokenizer, and drops filler", () => {
  assert.deepEqual(
    queryTerms("why did we decide to use a CLAUDE.local.md import for the Claude Desktop handoff"),
    ["claude", "local", "md", "import", "desktop", "handoff"],
  );
  assert.deepEqual(queryTerms("yes, continue"), []);
  assert.deepEqual(queryTerms("ok go ahead please"), []);
});

function seedCheckpoint(memory: MemoryDb, id: string, createdAt: string): void {
  memory.db
    .prepare(
      "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
        "VALUES (?, ?, '/tmp/w', 'codex', 's', 'export', 'dir', '{}')",
    )
    .run(id, createdAt);
}

function seedMessage(memory: MemoryDb, checkpointId: string, seq: number, text: string): void {
  memory.db
    .prepare("INSERT INTO messages (checkpoint_id, seq, role, text) VALUES (?, ?, 'user', ?)")
    .run(checkpointId, seq, text);
}

function seedItem(
  memory: MemoryDb,
  text: string,
  importance: number,
  options: { kind?: string; status?: string; reinforcedAt?: string; category?: string; createdAt?: string } = {},
): number {
  const result = memory.db
    .prepare(
      "INSERT INTO memory_items (kind, category, text, importance, status, created_at, last_reinforced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      options.kind ?? "semantic",
      options.category ?? null,
      text,
      importance,
      options.status ?? "active",
      options.createdAt ?? "2026-07-01T00:00:00Z",
      options.reinforcedAt ?? "2026-07-01T00:00:00Z",
    );
  return Number(result.lastInsertRowid);
}

test("code-like queries never throw and match exactly", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-1", "2026-07-01T00:00:00Z");
    seedMessage(memory, "cp-1", 0, "the call to prepareSwitch(runner, options) fails with TypeError");
    seedMessage(memory, "cp-1", 1, "unrelated content about deployment");
    const hits = await search(memory, "prepareSwitch(runner, options)", { now: "2026-07-02T00:00:00Z" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.source, "message");
  } finally {
    memory.close();
  }
});

test("importance and recency lift memory items over old messages", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-old", "2025-01-01T00:00:00Z");
    seedMessage(memory, "cp-old", 0, "we discussed the database schema at length");
    seedItem(memory, "decision: the database schema must stay backward compatible", 9, {
      reinforcedAt: "2026-07-01T00:00:00Z",
    });
    const hits = await search(memory, "database schema", { now: "2026-07-02T00:00:00Z" });
    assert.equal(hits[0]?.source, "memory_item");
    assert.equal(hits[0]?.importance, 9);
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
  } finally {
    memory.close();
  }
});

test("excludeMessages skips raw checkpoint messages but still returns memory_item and summary hits", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-1", "2026-07-01T00:00:00Z");
    seedMessage(memory, "cp-1", 0, "explain the architecture and flag the riskiest module please");
    seedItem(memory, "architecture decision: the riskiest module is the memory consolidation pipeline", 8);
    memory.db
      .prepare(
        "INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at) VALUES (1, ?, 'cp-1', 'cp-1', 1, ?)",
      )
      .run("architecture summary: the riskiest module is memory consolidation", "2026-07-01T00:00:00Z");

    const withMessages = await search(memory, "riskiest module architecture", { now: "2026-07-02T00:00:00Z" });
    assert.ok(withMessages.some((hit) => hit.source === "message"), "sanity check: the message would normally match");

    const excluded = await search(memory, "riskiest module architecture", {
      now: "2026-07-02T00:00:00Z",
      excludeMessages: true,
    });
    assert.ok(excluded.length > 0, "memory_item/summary hits should still be found");
    assert.ok(!excluded.some((hit) => hit.source === "message"), "no message-source hits should survive excludeMessages");
    assert.ok(excluded.some((hit) => hit.source === "memory_item"));
    assert.ok(excluded.some((hit) => hit.source === "summary"));
  } finally {
    memory.close();
  }
});

test("superseded and archived items are excluded; kind filter narrows results", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedItem(memory, "old fact about caching strategy", 5, { status: "superseded" });
    seedItem(memory, "current fact about caching strategy", 6);
    seedItem(memory, "episodic note about caching incident", 4, { kind: "episodic" });

    const all = await search(memory, "caching", { now: "2026-07-02T00:00:00Z" });
    assert.ok(all.every((hit) => !hit.text.startsWith("old fact")));

    const episodic = await search(memory, "caching", { kind: "episodic", now: "2026-07-02T00:00:00Z" });
    assert.equal(episodic.length, 1);
    assert.match(episodic[0]?.text ?? "", /incident/);
  } finally {
    memory.close();
  }
});

test("category and minImportance filters are pushed into SQL, not applied client-side", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedItem(memory, "we decided to freeze the api surface for the migration", 9, { category: "decision" });
    seedItem(memory, "prefer tabs for the migration config files", 3, { category: "preference" });
    seedItem(memory, "the migration touched twelve files in total", 5, { category: "fact" });

    const byCategory = await search(memory, "migration", { category: "decision", now: "2026-07-02T00:00:00Z" });
    assert.equal(byCategory.length, 1);
    assert.match(byCategory[0]?.text ?? "", /freeze the api surface/);

    const byImportance = await search(memory, "migration", { minImportance: 5, now: "2026-07-02T00:00:00Z" });
    assert.ok(byImportance.every((hit) => (hit.importance ?? 0) >= 5));
    assert.equal(byImportance.some((hit) => hit.text.includes("prefer tabs")), false);
  } finally {
    memory.close();
  }
});

test("since/until restrict results to a created_at date range", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedItem(memory, "early rollout decision about the payments migration", 8, { createdAt: "2026-01-01T00:00:00Z" });
    seedItem(memory, "later rollout decision about the payments migration", 8, { createdAt: "2026-06-01T00:00:00Z" });

    const recentOnly = await search(memory, "payments migration", {
      since: "2026-03-01T00:00:00Z",
      now: "2026-07-02T00:00:00Z",
    });
    assert.equal(recentOnly.length, 1);
    assert.match(recentOnly[0]?.text ?? "", /later rollout/);

    const oldOnly = await search(memory, "payments migration", {
      until: "2026-03-01T00:00:00Z",
      now: "2026-07-02T00:00:00Z",
    });
    assert.equal(oldOnly.length, 1);
    assert.match(oldOnly[0]?.text ?? "", /early rollout/);
  } finally {
    memory.close();
  }
});

test("limit caps the merged result set", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedCheckpoint(memory, "cp-1", "2026-07-01T00:00:00Z");
    for (let i = 0; i < 20; i += 1) seedMessage(memory, "cp-1", i, `retry logic attempt number ${i}`);
    const hits = await search(memory, "retry logic", { limit: 5, now: "2026-07-02T00:00:00Z" });
    assert.equal(hits.length, 5);
  } finally {
    memory.close();
  }
});

test("includeSuperseded controls whether rolled-up summaries are searchable", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const digest = memory.db
      .prepare(
        "INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at) " +
          "VALUES (2, 'epoch digest', 'cp-1', 'cp-1', 1, '2026-06-01T00:00:00Z')",
      )
      .run();
    memory.db
      .prepare(
        "INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at, superseded_by) " +
          "VALUES (1, 'the migration to the new queue system was completed', 'cp-1', 'cp-1', 1, '2026-06-01T00:00:00Z', ?)",
      )
      .run(Number(digest.lastInsertRowid));
    const excluded = await search(memory, "migration to the new queue system", { now: "2026-07-02T00:00:00Z" });
    assert.equal(excluded.some((hit) => hit.source === "summary"), false);

    const included = await search(memory, "migration to the new queue system", {
      now: "2026-07-02T00:00:00Z",
      includeSuperseded: true,
    });
    assert.equal(included.some((hit) => hit.source === "summary"), true);
  } finally {
    memory.close();
  }
});

test("reciprocal rank fusion rewards items that rank well across multiple lists", () => {
  const fused = reciprocalRankFusion(
    [
      ["a", "b", "c"],
      ["b", "a", "d"],
    ],
    (item) => item,
    60,
  );
  // "a" and "b" each appear in both lists (1/61 + 1/62), well above "c" and
  // "d" which each appear once at rank 3 (1/63) — a stable sort keeps the
  // rank-3 tie in first-seen order (c from list1, then d from list2).
  assert.deepEqual(fused.slice(0, 2).sort(), ["a", "b"]);
  assert.deepEqual(fused.slice(2), ["c", "d"]);
});

function fakeEmbeddings(vectors: Record<string, number[]>): EmbeddingClient {
  return {
    model: "fake-model",
    dim: 2,
    async embed(texts) {
      return texts.map((text) => Float32Array.from(vectors[text] ?? [0, 0]));
    },
  };
}

test("vector search surfaces a semantically related item FTS alone would miss", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const oauthText = "We standardized on OAuth2 for authentication across services.";
    const changelogText = "Updated the changelog formatting for the release notes.";
    const query = "login flow security review";
    for (const text of [oauthText, changelogText]) seedItem(memory, text, 6);

    // No shared keywords between the query and the OAuth item, so FTS alone finds nothing.
    const ftsOnly = await search(memory, query, { now: "2026-07-02T00:00:00Z" });
    assert.equal(ftsOnly.some((hit) => hit.text === oauthText), false);

    memory.db
      .prepare("UPDATE memory_items SET embedding = ?, embedding_model = 'fake-model' WHERE text = ?")
      .run(toBlob(Float32Array.from([1, 0])), oauthText);
    memory.db
      .prepare("UPDATE memory_items SET embedding = ?, embedding_model = 'fake-model' WHERE text = ?")
      .run(toBlob(Float32Array.from([0, 1])), changelogText);

    const embeddings = fakeEmbeddings({ [query]: [0.95, 0.05] });
    const hybrid = await search(memory, query, { now: "2026-07-02T00:00:00Z", embeddings });
    assert.equal(hybrid.some((hit) => hit.text === oauthText), true);
  } finally {
    memory.close();
  }
});

// Regression for the per-prompt injection bug: every word of a natural-language
// prompt had to appear in one row, so real prompts never matched anything.
test("natural-language prompts retrieve the matching memory through the automatic gate", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const handoff = seedItem(
      memory,
      "Claude Desktop handoff loading is implemented through a managed `CLAUDE.local.md` import of `.mixai/current/HANDOFF.md`.",
      9,
    );
    const hookLabels = seedItem(
      memory,
      "Hook registrations now include documented `statusMessage` labels so Codex Desktop approval prompts can show semantic names.",
      8,
    );
    seedItem(memory, "After the hook-label changes, the repository test suite passed with 153 tests.", 6);
    seedItem(memory, "Passing a project folder to `open -a Claude` routes Claude Desktop to Cowork instead of Code.", 8);
    const options = { now: "2026-07-02T00:00:00Z", excludeMessages: true, ...AUTOMATIC_INJECTION_GATE };

    const decision = await search(memory, "why did we decide to use a CLAUDE.local.md import for the Claude Desktop handoff", options);
    assert.equal(decision[0]?.id, handoff);
    assert.deepEqual(decision[0]?.matchedTerms, ["claude", "local", "md", "import", "desktop", "handoff"]);

    const labels = await search(memory, "how do Codex Desktop approval prompts label our hooks?", options);
    assert.equal(labels[0]?.id, hookLabels);
  } finally {
    memory.close();
  }
});

test("the automatic gate injects nothing for filler, one-common-word, or unknown-topic prompts", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedItem(memory, "Claude Desktop handoff loading is implemented through a managed `CLAUDE.local.md` import.", 9);
    seedItem(memory, "After the hook-label changes, the repository test suite passed with 153 tests.", 6);
    seedItem(memory, "Claude Desktop login does not authenticate the separate claude terminal client.", 8);
    const options = { now: "2026-07-02T00:00:00Z", excludeMessages: true, ...AUTOMATIC_INJECTION_GATE };

    assert.deepEqual(await search(memory, "yes, continue", options), []);
    assert.deepEqual(await search(memory, "fix the failing test in the router", options), []);
    assert.deepEqual(await search(memory, "let's deploy the claude handoff to kubernetes", options), []);

    // A deliberate search (no gate) still shows the partial matches.
    const deliberate = await search(memory, "fix the failing test in the router", { now: "2026-07-02T00:00:00Z" });
    assert.ok(deliberate.some((hit) => hit.text.includes("test suite")));
  } finally {
    memory.close();
  }
});

test("a brand-new project with a single memory still injects for a natural question", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedItem(memory, "We decided to keep all prices in integer cents, never floats.", 8);
    const hits = await search(memory, "how do we store prices, integer cents or floats?", { excludeMessages: true, ...AUTOMATIC_INJECTION_GATE });
    assert.equal(hits.length, 1);
    assert.deepEqual(await search(memory, "let's deploy the billing service to kubernetes", { excludeMessages: true, ...AUTOMATIC_INJECTION_GATE }), []);
  } finally {
    memory.close();
  }
});
