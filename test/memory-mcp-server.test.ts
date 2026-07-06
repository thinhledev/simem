import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { loadSqlite, openMemoryDb, type MemoryDb } from "../src/memory/db.js";
import { handleRequest, PROTOCOL_VERSION, runMcpServer, SERVER_INFO } from "../src/memory/mcp-server.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

async function withMemory(run: (memory: MemoryDb, cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "cag-mcp-"));
  const memory = await openMemoryDb(cwd);
  if (!memory) throw new Error("expected node:sqlite to be available for this test");
  try {
    await run(memory, cwd);
  } finally {
    memory.close();
  }
}

test("initialize returns server info and capabilities", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    const response = await handleRequest(
      memory,
      cwd,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    );
    assert.equal(response?.id, 1);
    assert.deepEqual(response?.result, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  });
});

test("tools/list advertises memory_search, memory_get, and memory_save", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    const response = await handleRequest(memory, cwd, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const tools = (response?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.deepEqual(tools.sort(), ["memory_get", "memory_save", "memory_search"]);
  });
});

test("tools/call memory_save writes a row, then memory_search finds it", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    const save = await handleRequest(
      memory,
      cwd,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "memory_save",
          arguments: { text: "Never rotate the signing key without a maintenance window.", kind: "semantic", category: "constraint", importance: 9 },
        },
      }),
    );
    const saveResult = JSON.parse((save?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
    assert.equal(typeof saveResult.id, "number");

    const search = await handleRequest(
      memory,
      cwd,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "signing key maintenance window" } },
      }),
    );
    const payload = JSON.parse((search?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
    assert.ok(Array.isArray(payload.hits));
    assert.equal(typeof payload.hint, "string");
    assert.ok(payload.hits.some((hit: { preview: string }) => hit.preview.includes("signing key")));
    assert.equal(payload.hits[0]?.text, undefined, "preview mode must not include raw text");
  });
});

test("tools/call memory_search returns full RetrievalHit[] unchanged when full: true is set", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    memory.db
      .prepare(
        "INSERT INTO memory_items (kind, text, importance, status, created_at, last_reinforced_at) " +
          "VALUES ('semantic', ?, 8, 'active', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z')",
      )
      .run("Full text mode should return this verbatim without truncation.");
    const response = await handleRequest(
      memory,
      cwd,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "full text mode", full: true } },
      }),
    );
    const hits = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "[]");
    assert.ok(Array.isArray(hits));
    assert.equal(hits[0]?.text, "Full text mode should return this verbatim without truncation.");
  });
});

test("tools/call memory_search caps the envelope size and marks it truncated when many previews still add up", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    const insert = memory.db.prepare(
      "INSERT INTO memory_items (kind, text, importance, status, created_at, last_reinforced_at) " +
        "VALUES ('semantic', ?, 5, 'active', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z')",
    );
    for (let i = 0; i < 50; i += 1) {
      insert.run(`Envelope size guard candidate number ${i} discussing the migration rollout plan in detail.`);
    }
    const response = await handleRequest(
      memory,
      cwd,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "migration rollout plan", limit: 50 } },
      }),
    );
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
    assert.equal(payload.truncated, true);
    assert.ok(JSON.stringify(payload.hits).length <= 8_000);
  });
});

test("tools/call memory_get returns a checkpoint by id and a memory item by numeric id", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    memory.db
      .prepare(
        "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
          "VALUES ('cp-1', '2026-07-03T00:00:00Z', ?, 'codex', 's', 'export', 'dir', '{}')",
      )
      .run(cwd);
    const byCheckpoint = await handleRequest(
      memory,
      cwd,
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_get", arguments: { selector: "cp-1" } } }),
    );
    const checkpointRecord = JSON.parse((byCheckpoint?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
    assert.equal(checkpointRecord.type, "checkpoint");

    const missing = await handleRequest(
      memory,
      cwd,
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "memory_get", arguments: { selector: "does-not-exist" } } }),
    );
    assert.equal(missing?.error?.code, -32_603);
  });
});

test("malformed JSON and unknown methods produce JSON-RPC error codes without throwing", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    const parseError = await handleRequest(memory, cwd, "{not json");
    assert.equal(parseError?.error?.code, -32_700);

    const methodNotFound = await handleRequest(memory, cwd, JSON.stringify({ jsonrpc: "2.0", id: 7, method: "does/not/exist" }));
    assert.equal(methodNotFound?.error?.code, -32_601);

    const missingMethod = await handleRequest(memory, cwd, JSON.stringify({ jsonrpc: "2.0", id: 8 }));
    assert.equal(missingMethod?.error?.code, -32_600);

    const badToolCall = await handleRequest(
      memory,
      cwd,
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { arguments: {} } }),
    );
    assert.equal(badToolCall?.error?.code, -32_602);
  });
});

test("runMcpServer streams newline-delimited JSON-RPC responses over stdio", withSqlite, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cag-mcp-stdio-"));
  await mkdir(join(cwd, ".cag"), { recursive: true });
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

  const serverPromise = runMcpServer(cwd, { input, output });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  input.end();
  await serverPromise;

  const lines = chunks.join("").trim().split("\n").map((line) => JSON.parse(line) as { id: number });
  assert.deepEqual(lines.map((line) => line.id), [1, 2]);
});
