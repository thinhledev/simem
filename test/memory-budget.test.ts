import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { assembleContext } from "../src/memory/budget.js";
import { loadSqlite, openMemoryDb, type MemoryDb } from "../src/memory/db.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };
const budget = DEFAULT_CONFIG.memory.budget;
const scoring = DEFAULT_CONFIG.memory.scoring;

function seedItem(memory: MemoryDb, text: string, importance: number): void {
  memory.db
    .prepare(
      "INSERT INTO memory_items (kind, category, text, importance, status, created_at, last_reinforced_at) " +
        "VALUES ('semantic', 'constraint', ?, ?, 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
    )
    .run(text, importance);
}

test("returns an empty block when the memory database has no content", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const assembled = await assembleContext(memory, "continue the refactor", budget, scoring);
    assert.equal(assembled.text, "");
    assert.equal(assembled.truncated, false);
  } finally {
    memory.close();
  }
});

test("includes durable decisions above the importance floor and excludes low-importance facts", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    seedItem(memory, "Never downgrade the auth library below v3.", 9);
    seedItem(memory, "The team prefers tabs over spaces.", 3);
    const assembled = await assembleContext(memory, "auth work", budget, scoring);
    assert.match(assembled.text, /## Project memory/);
    assert.match(assembled.text, /Durable decisions & constraints/);
    assert.match(assembled.text, /Never downgrade the auth library/);
    assert.doesNotMatch(assembled.text, /tabs over spaces/);
  } finally {
    memory.close();
  }
});

test("respects the semantic section character budget", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    for (let i = 0; i < 200; i += 1) seedItem(memory, `Constraint number ${i} about the deployment pipeline.`, 8);
    const tightBudget = { ...budget, semanticChars: 200, totalChars: 20_000 };
    const assembled = await assembleContext(memory, "deployment", tightBudget, scoring);
    const durableSection = (assembled.text.split("### Durable decisions & constraints\n\n")[1] ?? "").split(
      "\n\nFor more:",
    )[0] ?? "";
    assert.ok(durableSection.length <= 220, `section too long: ${durableSection.length}`);
    assert.ok(!durableSection.includes("Constraint number 0 "), "only a prefix of items should survive the budget");
    assert.equal(assembled.truncated, true);
  } finally {
    memory.close();
  }
});

test("caps and deduplicates retrieved history so one repeated message can't dominate the section", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    memory.db
      .prepare(
        "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
          "VALUES ('cp-1', '2026-07-01T00:00:00Z', '/tmp/w', 'codex', 's', 'export', 'dir', '{}')",
      )
      .run();
    const longRepeated = `Antigravity migration notes. ${"detail ".repeat(80)}`;
    const insertMessage = memory.db.prepare("INSERT INTO messages (checkpoint_id, seq, role, text) VALUES ('cp-1', ?, 'assistant', ?)");
    for (let i = 0; i < 5; i += 1) insertMessage.run(i, longRepeated);
    insertMessage.run(5, "Antigravity migration also needs a rollback plan.");

    const assembled = await assembleContext(memory, "antigravity migration", budget, scoring);
    const retrievedSection = (assembled.text.split("### Relevant history\n\n")[1] ?? "").split("\n\nFor more:")[0];
    const bullets = retrievedSection.split("\n").filter(Boolean);
    const uniqueBullets = new Set(bullets);
    assert.equal(bullets.length, uniqueBullets.size, "duplicate messages should not repeat as separate bullets");
    for (const bullet of bullets) assert.ok(bullet.length <= 245, `bullet too long: ${bullet.length}`);
  } finally {
    memory.close();
  }
});

test("prefers the highest active summary level for the project digest", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    memory.db
      .prepare(
        "INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at) VALUES (1, 'level one summary', 'cp-1', 'cp-1', 1, '2026-07-01T00:00:00Z')",
      )
      .run();
    memory.db
      .prepare(
        "INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at) VALUES (2, 'level two digest', 'cp-1', 'cp-5', 5, '2026-07-02T00:00:00Z')",
      )
      .run();
    const assembled = await assembleContext(memory, "anything", budget, scoring);
    assert.match(assembled.text, /level two digest/);
    assert.doesNotMatch(assembled.text, /level one summary/);
  } finally {
    memory.close();
  }
});
