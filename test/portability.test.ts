import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSqlite, openMemoryDb, type MemoryDb } from "../src/memory/db.js";
import { upsertMemoryItem } from "../src/memory/items.js";
import { search } from "../src/memory/retrieval.js";
import { decodeBundle, encodeBundle, exportBundle, importBundle, syncThroughDir } from "../src/portability/bundle.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };
const project = { id: "p1", name: "shop" };

async function store(): Promise<MemoryDb> {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:", quiet: true });
  assert.ok(memory);
  return memory;
}

test("export then import into a fresh store gives the same recall, and a second import adds nothing", withSqlite, async () => {
  const source = await store();
  const target = await store();
  try {
    upsertMemoryItem(source, { kind: "semantic", category: "decision", text: "We decided to use Postgres for persistence.", importance: 9, origin: "rule" });
    upsertMemoryItem(source, { kind: "semantic", category: "constraint", text: "Never deploy on Fridays.", importance: 8, origin: "agent" });
    source.db.prepare("UPDATE memory_items SET status = 'archived' WHERE text LIKE 'Never deploy%'").run();
    source.db.prepare("INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at) VALUES (1, 'Objective: set up the db.', 'cp1', 'cp1', 1, 't')").run();
    const bundle = exportBundle(source, project);
    const first = importBundle(target, bundle);
    assert.deepEqual({ ...first, messages: 0 }, { items: 2, reinforced: 0, summaries: 1, sessions: 0, messages: 0 });
    const again = importBundle(target, bundle);
    assert.deepEqual(again, { items: 0, reinforced: 2, summaries: 0, sessions: 0, messages: 0 });
    const left = (await search(source, "which database do we persist with postgres")).map((hit) => hit.text);
    const right = (await search(target, "which database do we persist with postgres")).map((hit) => hit.text);
    assert.deepEqual(right, left, "identical recall result after export/import");
    const archived = target.db.prepare("SELECT status FROM memory_items WHERE text LIKE 'Never deploy%'").get() as { status: string };
    assert.equal(archived.status, "archived", "forgotten stays forgotten");
  } finally {
    source.close();
    target.close();
  }
});

test("encrypted bundles need the passphrase; a wrong one fails clearly", () => {
  const encoded = encodeBundle('{"kind":"header"}\n', "correct horse");
  assert.equal(encoded.subarray(0, 9).toString(), "SIMEMENC1");
  assert.equal(decodeBundle(encoded, "correct horse"), '{"kind":"header"}\n');
  assert.throws(() => decodeBundle(encoded), /encrypted; set SIMEM_SYNC_PASSPHRASE/);
  assert.throws(() => decodeBundle(encoded, "wrong"), /wrong SIMEM_SYNC_PASSPHRASE/);
  assert.equal(decodeBundle(encodeBundle("plain\n")), "plain\n");
});

test("two machines converge through a shared sync folder", withSqlite, async () => {
  const dir = mkdtempSync(join(tmpdir(), "simem-syncdir-"));
  const home = process.env.SIMEM_HOME;
  const laptop = await store();
  const desktop = await store();
  try {
    process.env.SIMEM_HOME = mkdtempSync(join(tmpdir(), "simem-machine-a-"));
    upsertMemoryItem(laptop, { kind: "semantic", text: "Logging uses pino on the laptop setup.", importance: 7, origin: "rule" });
    syncThroughDir(laptop, project, dir, "s3cret");
    process.env.SIMEM_HOME = mkdtempSync(join(tmpdir(), "simem-machine-b-"));
    upsertMemoryItem(desktop, { kind: "semantic", text: "Caching uses Redis with a five minute TTL.", importance: 7, origin: "rule" });
    const fromLaptop = syncThroughDir(desktop, project, dir, "s3cret");
    assert.equal(fromLaptop.imported[0]?.items, 1);
    assert.equal(readdirSync(dir).filter((name) => name.endsWith(".simem.enc")).length, 2);
    const count = (memory: MemoryDb) => (memory.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number }).n;
    assert.equal(count(desktop), 2);
  } finally {
    process.env.SIMEM_HOME = home;
    laptop.close();
    desktop.close();
  }
});
