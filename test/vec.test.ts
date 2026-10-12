import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import { toBlob, type EmbeddingClient } from "../src/memory/embeddings.js";
import { search } from "../src/memory/retrieval.js";
import { installModel, modelInstalled, type ModelSpec } from "../src/vec/install.js";
import { createStaticModel, readSafetensorsF32 } from "../src/vec/model.js";
import { normalize, preTokenize, WordPieceTokenizer } from "../src/vec/wordpiece.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

test("BERT normalization lowercases, strips accents, drops control chars, and spaces CJK", () => {
  assert.equal(normalize("Naïve CAFÉ\u0000\tx"), "naive cafe x");
  assert.equal(normalize("中文"), " 中  文 ");
});

test("pre-tokenization splits on whitespace and every punctuation character", () => {
  assert.deepEqual(preTokenize("claude.local.md, rate-limit!"), ["claude", ".", "local", ".", "md", ",", "rate", "-", "limit", "!"]);
});

test("WordPiece is greedy longest-match-first with ## continuations and [UNK] for unknown words", () => {
  const vocab = new Map(["[UNK]", "hand", "##off", "##o", "un", "##bel", "md", "."].map((token, index) => [token, index]));
  const tokenizer = new WordPieceTokenizer({ vocab });
  assert.deepEqual(tokenizer.encode("handoff md."), [1, 2, 6, 7]);
  assert.deepEqual(tokenizer.encode("zzz"), [0]);
  assert.deepEqual(tokenizer.encode("hand off", 1), [1]);
});

function safetensors(rows: number[][]): Buffer {
  const dim = rows[0]!.length;
  const data = Buffer.from(new Float32Array(rows.flat()).buffer);
  const header = Buffer.from(JSON.stringify({ embeddings: { dtype: "F32", shape: [rows.length, dim], data_offsets: [0, data.length] } }));
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, data]);
}

test("the static model averages token rows, drops [UNK], and L2-normalizes", () => {
  const { data, shape } = readSafetensorsF32(safetensors([[0, 0], [3, 0], [0, 4]]), "embeddings");
  assert.deepEqual(shape, [3, 2]);
  const model = createStaticModel("tiny", new Map([["[UNK]", 0], ["east", 1], ["north", 2]]), data, 2);
  const east = model.encode("east");
  assert.deepEqual([...east], [1, 0]);
  const mixed = model.encode("east north zzz");
  assert.ok(Math.abs(mixed[0]! - 0.6) < 1e-6 && Math.abs(mixed[1]! - 0.8) < 1e-6, `got ${[...mixed]}`);
  assert.deepEqual([...model.encode("zzz")], [0, 0], "only unknown tokens: zero vector, never NaN");
});

test("installModel verifies checksums and refuses a tampered file", async () => {
  const good = Buffer.from("model bytes");
  const spec: ModelSpec = { name: "fake", baseUrl: "https://example.invalid/rev", files: { "model.safetensors": createHash("sha256").update(good).digest("hex") }, megabytes: 1 };
  const dir = mkdtempSync(join(tmpdir(), "mixai-model-"));
  const tampered = await installModel(spec, dir, (async () => new Response("evil bytes")) as typeof fetch);
  assert.equal(tampered.status, "failed");
  assert.equal(modelInstalled(spec, dir), false);
  const ok = await installModel(spec, dir, (async () => new Response(good)) as typeof fetch);
  assert.equal(ok.status, "installed");
  assert.equal(readFileSync(join(dir, "model.safetensors"), "utf8"), "model bytes");
  assert.equal((await installModel(spec, dir, (async () => { throw new Error("no network needed"); }) as typeof fetch)).status, "present");
});

test("hybrid gate: a vector-only match passes only above the strong cutoff; keyword matches still pass", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const insert = memory.db.prepare(
      "INSERT INTO memory_items (kind, text, importance, created_at, last_reinforced_at, embedding, embedding_model) VALUES ('semantic', ?, 7, 't', 't', ?, 'fake')",
    );
    insert.run("Passing a folder to open routes the desktop app to Cowork.", toBlob(Float32Array.from([1, 0])));
    insert.run("Logging uses pino in production.", toBlob(Float32Array.from([0, 1])));
    const fake = (vector: number[]): EmbeddingClient => ({ model: "fake", dim: 2, embed: async () => [Float32Array.from(vector)] });
    const gate = { minCoverage: 0.5, minMatchedTerms: 2, strongSimilarity: 0.9 };
    const strong = await search(memory, "why does the app open the wrong window", { ...gate, excludeMessages: true, embeddings: fake([0.99, 0.1]) });
    assert.ok(strong.some((hit) => hit.text.includes("Cowork")));
    const weak = await search(memory, "why does the app open the wrong window", { ...gate, excludeMessages: true, embeddings: fake([0.6, 0.8]) });
    assert.deepEqual(weak, []);
  } finally {
    memory.close();
  }
});

test("labelled set: the keyword gate finds every exact question and never injects on off-topic or filler prompts", withSqlite, async () => {
  const { evaluateGate } = await import("../src/vec/eval.js");
  const { AUTOMATIC_INJECTION_GATE } = await import("../src/memory/retrieval.js");
  const metrics = await evaluateGate(AUTOMATIC_INJECTION_GATE);
  assert.equal(metrics.exactRecall, 1);
  assert.equal(metrics.falseInjections, 0);
  assert.equal(metrics.precision, 1);
});
