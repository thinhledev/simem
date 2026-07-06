import assert from "node:assert/strict";
import test from "node:test";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import { recordSavings, savingsSummary, savingsTotals } from "../src/memory/savings.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

test("recordSavings stores exact char deltas per mechanism", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    recordSavings(memory, { mechanism: "compaction", charsFull: 4000, charsSent: 400 });
    recordSavings(memory, { mechanism: "disclosure", charsFull: 1000, charsSent: 240 });
    const row = memory.db.prepare("SELECT mechanism, chars_full, chars_sent FROM savings_events ORDER BY id").all() as Array<{
      mechanism: string;
      chars_full: number;
      chars_sent: number;
    }>;
    assert.equal(row.length, 2);
    assert.deepEqual(
      row.map((entry) => entry.mechanism),
      ["compaction", "disclosure"],
    );
  } finally {
    memory.close();
  }
});

test("recordSavings skips rows where nothing was actually saved (no zero/negative noise)", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    recordSavings(memory, { mechanism: "rollup-cap", charsFull: 100, charsSent: 100 });
    recordSavings(memory, { mechanism: "rollup-cap", charsFull: 50, charsSent: 80 });
    const count = memory.db.prepare("SELECT COUNT(*) AS n FROM savings_events").get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    memory.close();
  }
});

test("a savings-recording failure never throws (best-effort)", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  memory.close(); // closed handle makes the INSERT fail internally
  assert.doesNotThrow(() => recordSavings(memory, { mechanism: "compaction", charsFull: 100, charsSent: 10 }));
});

test("savingsSummary groups by mechanism and savingsTotals aggregates everything", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    recordSavings(memory, { mechanism: "compaction", charsFull: 4000, charsSent: 400 }); // saved 3600
    recordSavings(memory, { mechanism: "compaction", charsFull: 2000, charsSent: 200 }); // saved 1800
    recordSavings(memory, { mechanism: "disclosure", charsFull: 1000, charsSent: 240 }); // saved 760

    const rows = savingsSummary(memory);
    assert.deepEqual(rows.map((row) => row.mechanism), ["compaction", "disclosure"]); // ordered by charsSaved DESC
    const compaction = rows.find((row) => row.mechanism === "compaction");
    assert.equal(compaction?.events, 2);
    assert.equal(compaction?.charsSaved, 5400);
    assert.equal(compaction?.estimatedTokensSaved, Math.round(5400 / 4));

    const totals = savingsTotals(memory);
    assert.equal(totals.events, 3);
    assert.equal(totals.charsSaved, 5400 + 760);
    assert.equal(totals.estimatedTokensSaved, Math.round((5400 + 760) / 4));
  } finally {
    memory.close();
  }
});

test("savingsTotals on an empty database reports zero, not an error", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const totals = savingsTotals(memory);
    assert.deepEqual(totals, { events: 0, charsSaved: 0, estimatedTokensSaved: 0 });
    assert.deepEqual(savingsSummary(memory), []);
  } finally {
    memory.close();
  }
});
