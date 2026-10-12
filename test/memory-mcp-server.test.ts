import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { loadSqlite, openMemoryDb, type MemoryDb } from "../src/memory/db.js";
import { handleRequest, PROTOCOL_VERSION, runMcpServer, SERVER_INFO } from "../src/memory/mcp-server.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

async function withMemory(run: (memory: MemoryDb, cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "mixai-mcp-"));
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

test("tools/list advertises memory tools, context_brief, and the handoff tools", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    const response = await handleRequest(memory, cwd, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const tools = (response?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.deepEqual(tools.sort(), [
      "code_find_references",
      "code_outline",
      "code_read",
      "code_search",
      "context_brief",
      "list_handoff_targets",
      "memory_forget",
      "memory_get",
      "memory_save",
      "memory_search",
      "memory_stats",
      "mixai_doctor",
      "output_get",
      "recall",
      "repo_map",
      "switch_to_provider",
    ]);
  });
});

test("tools/call context_brief returns a brief and works even without a memory database", withSqlite, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixai-mcp-brief-"));
  const fakeRunner = {
    async run() {
      return { exitCode: 0, stdout: "main\n", stderr: "", durationMs: 1, timedOut: false };
    },
  };
  const deps = { runner: fakeRunner, memoryConfig: { ...DEFAULT_CONFIG.memory, enabled: false } };
  // memory === undefined simulates a Node < 22.5 runtime; context_brief must
  // still answer while the DB-backed tools error out.
  const response = await handleRequest(
    undefined,
    cwd,
    JSON.stringify({ jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "context_brief", arguments: {} } }),
    deps,
  );
  const brief = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
  assert.match(brief.text, /## Context brief/);
  assert.match(brief.text, /Checkpoint: none yet/);
  assert.equal(brief.hasMemory, false);

  const dbTool = await handleRequest(
    undefined,
    cwd,
    JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "memory_search", arguments: { query: "x" } } }),
    deps,
  );
  assert.match(dbTool?.error?.message ?? "", /memory database is unavailable/);
});

function fakeReadiness(readyProviders: Set<string>, readySurface: "desktop" | "interactive" = "interactive"): (
  runner: unknown,
  provider: string,
  surface: "desktop" | "interactive",
) => Promise<{ ready: boolean; message?: string; loginCommand?: string }> {
  return async (_runner, provider, surface) => {
    if (surface === readySurface && readyProviders.has(provider)) return { ready: true };
    return surface === "desktop"
      ? { ready: false, message: "Desktop launching is currently supported on macOS" }
      : { ready: false, message: `${provider} is not authenticated`, loginCommand: `${provider} login` };
  };
}

test("tools/call list_handoff_targets excludes the calling agent and reports readiness for the rest", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixai-mcp-targets-"));
  const deps = {
    runner: { async run() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }; } },
    memoryConfig: DEFAULT_CONFIG.memory,
    selfProvider: "claude" as const,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    checkReadiness: fakeReadiness(new Set(["codex"])) as any,
  };
  const response = await handleRequest(
    undefined,
    cwd,
    JSON.stringify({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "list_handoff_targets", arguments: {} } }),
    deps,
  );
  const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
  assert.equal(payload.self, "claude");
  const providers = payload.targets.map((target: { provider: string }) => target.provider).sort();
  assert.deepEqual(providers, ["antigravity", "codex", "cursor"], "claude (self) must not appear as a target");
  const codex = payload.targets.find((target: { provider: string }) => target.provider === "codex");
  assert.equal(codex.ready, true);
  assert.equal(codex.surface, "interactive");
  const cursor = payload.targets.find((target: { provider: string }) => target.provider === "cursor");
  assert.equal(cursor.ready, false);
  assert.match(cursor.detail, /not authenticated/);
});

test("tools/call list_handoff_targets lists all four providers when selfProvider is unknown", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixai-mcp-targets-noself-"));
  const deps = {
    runner: { async run() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }; } },
    memoryConfig: DEFAULT_CONFIG.memory,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    checkReadiness: fakeReadiness(new Set()) as any,
  };
  const response = await handleRequest(
    undefined,
    cwd,
    JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "list_handoff_targets", arguments: {} } }),
    deps,
  );
  const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
  assert.equal(payload.self, null);
  assert.equal(payload.targets.length, 4);
});

test("tools/call switch_to_provider rejects targeting the calling agent itself", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixai-mcp-switch-self-"));
  const deps = {
    runner: { async run() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }; } },
    memoryConfig: DEFAULT_CONFIG.memory,
    selfProvider: "claude" as const,
  };
  const response = await handleRequest(
    undefined,
    cwd,
    JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "switch_to_provider", arguments: { target: "claude" } } }),
    deps,
  );
  assert.match(response?.error?.message ?? "", /must differ from the calling agent/);
});

test("tools/call switch_to_provider returns not_ready without launching anything when the target isn't ready", withSqlite, async () => {
  await withMemory(async (_memory, cwd) => {
    const deps = {
      runner: { async run() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false }; } },
      memoryConfig: DEFAULT_CONFIG.memory,
      selfProvider: "claude" as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      checkReadiness: fakeReadiness(new Set()) as any,
      launch: async () => {
        throw new Error("launch must not be called when the target is not ready");
      },
    };
    const response = await handleRequest(
      undefined,
      cwd,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 43,
        method: "tools/call",
        params: { name: "switch_to_provider", arguments: { target: "codex", surface: "interactive" } },
      }),
      deps,
    );
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "not_ready");
    assert.match(payload.loginCommand, /codex login/);
  });
});

test("tools/call switch_to_provider checkpoints and returns a manual command on interactive surface (no unsafe auto-spawn)", withSqlite, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixai-mcp-switch-interactive-"));
  await mkdir(join(cwd, "src"), { recursive: true });
  const sessionPath = join(cwd, "session.jsonl");
  await writeFile(
    sessionPath,
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the parser" }] } }),
  );
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(cwd, "empty-codex-home");
  try {
    const gitRunner = {
      async run(spec: { args?: string[] }) {
        const args = spec.args ?? [];
        let stdout = "";
        if (args[0] === "branch") stdout = "main\n";
        else if (args[0] === "rev-parse") stdout = "abc123\n";
        else if (args[0] === "status") stdout = "## main\n";
        else if (args[0] === "log") stdout = "abc123 tip\n";
        return { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false };
      },
    };
    let launchCalled = false;
    let consolidationSpawned = false;
    const deps = {
      runner: gitRunner,
      memoryConfig: { ...DEFAULT_CONFIG.memory, enabled: true },
      selfProvider: "claude" as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      checkReadiness: fakeReadiness(new Set(["codex"])) as any,
      launch: async () => {
        launchCalled = true;
        return 0;
      },
      spawnConsolidation: () => {
        consolidationSpawned = true;
      },
    };
    // prepareSwitch resolves the source session for deps.selfProvider ("claude"),
    // so seed one to check the checkpoint out.
    const claudeProjects = join(cwd, ".claude-home", "projects", "p");
    await mkdir(claudeProjects, { recursive: true });
    await writeFile(
      join(claudeProjects, "claude-1.jsonl"),
      JSON.stringify({ type: "user", sessionId: "claude-1", cwd, message: { role: "user", content: "Fix the parser" } }),
    );
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(cwd, ".claude-home");
    try {
      const response = await handleRequest(
        undefined,
        cwd,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 44,
          method: "tools/call",
          params: { name: "switch_to_provider", arguments: { target: "codex", surface: "interactive" } },
        }),
        deps,
      );
      const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
      assert.equal(payload.ok, true);
      assert.equal(payload.launched, false, "interactive surface must not auto-spawn (would inherit this server's own stdio)");
      assert.match(payload.manualCommand, /codex/);
      assert.ok(payload.checkpointId);
      assert.equal(launchCalled, false);
      assert.equal(consolidationSpawned, true);
    } finally {
      if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    }
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test("tools/call switch_to_provider launches on desktop surface via the injected launcher", withSqlite, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mixai-mcp-switch-desktop-"));
  const claudeProjects = join(cwd, ".claude-home", "projects", "p");
  await mkdir(claudeProjects, { recursive: true });
  await writeFile(
    join(claudeProjects, "claude-1.jsonl"),
    JSON.stringify({ type: "user", sessionId: "claude-1", cwd, message: { role: "user", content: "Fix the parser" } }),
  );
  const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(cwd, ".claude-home");
  try {
    let launchedPlan: { command: string } | undefined;
    const deps = {
      runner: {
        async run(spec: { args?: string[] }) {
          const args = spec.args ?? [];
          let stdout = "";
          if (args[0] === "branch") stdout = "main\n";
          else if (args[0] === "rev-parse") stdout = "abc123\n";
          else if (args[0] === "status") stdout = "## main\n";
          else if (args[0] === "log") stdout = "abc123 tip\n";
          return { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false };
        },
      },
      memoryConfig: { ...DEFAULT_CONFIG.memory, enabled: false },
      selfProvider: "claude" as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      checkReadiness: fakeReadiness(new Set(["cursor"]), "desktop") as any,
      launch: async (plan: { command: string }) => {
        launchedPlan = plan;
        return 0;
      },
    };
    const response = await handleRequest(
      undefined,
      cwd,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 45,
        method: "tools/call",
        params: { name: "switch_to_provider", arguments: { target: "cursor", surface: "desktop" } },
      }),
      deps,
    );
    const payload = JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
    assert.equal(payload.ok, true);
    assert.equal(payload.launched, true);
    assert.ok(launchedPlan, "the injected launcher should have been called");
  } finally {
    if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
  }
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

test("tools/call memory_save reinforces a restated fact instead of duplicating it", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    const save = async (id: number, text: string) => {
      const response = await handleRequest(
        memory,
        cwd,
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "memory_save", arguments: { text, kind: "semantic", category: "decision", importance: 8 } },
        }),
      );
      return JSON.parse((response?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
    };
    const first = await save(40, "Vectors are stored inside memory.db.");
    const again = await save(41, "vectors are stored inside `memory.db`");
    assert.deepEqual(again, { id: first.id, reinforced: true });
    const row = memory.db.prepare("SELECT origin FROM memory_items WHERE id = ?").get(first.id) as { origin: string };
    assert.equal(row.origin, "agent");
  });
});

test("tools/call memory_save survives a state.json pointing at an unindexed checkpoint", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    // A checkpoint whose files exist on disk but whose row never made it into
    // the database (indexCheckpointBestEffort failed silently). The foreign key
    // on memory_items.source_checkpoint_id used to reject every save.
    await mkdir(join(cwd, ".mixai"), { recursive: true });
    await writeFile(
      join(cwd, ".mixai", "state.json"),
      JSON.stringify({ version: 1, checkpoints: {}, sessions: {}, currentCheckpointId: "2026-07-09T05-04-45-416Z-f99ce6b7" }),
      "utf8",
    );
    const save = await handleRequest(
      memory,
      cwd,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "memory_save",
          arguments: { text: "Saves must not depend on the checkpoint being indexed.", kind: "semantic", importance: 7 },
        },
      }),
    );
    assert.equal(save?.error, undefined, "a stale currentCheckpointId must not fail the save");
    const saveResult = JSON.parse((save?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
    assert.equal(typeof saveResult.id, "number");
    const row = memory.db
      .prepare("SELECT source_checkpoint_id FROM memory_items WHERE id = ?")
      .get(saveResult.id) as { source_checkpoint_id: string | null };
    assert.equal(row.source_checkpoint_id, null, "unknown provenance is dropped, not forced");
  });
});

test("tools/call memory_save keeps provenance when the checkpoint is indexed", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    memory.db
      .prepare(
        "INSERT INTO checkpoints " +
          "(id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
          "VALUES (?, '2026-07-09T05:04:45Z', ?, 'claude', 'session-1', 'fresh', ?, '{}')",
      )
      .run("2026-07-09T05-04-45-416Z-f99ce6b7", cwd, join(cwd, ".mixai", "checkpoints", "cp"));
    await mkdir(join(cwd, ".mixai"), { recursive: true });
    await writeFile(
      join(cwd, ".mixai", "state.json"),
      JSON.stringify({ version: 1, checkpoints: {}, sessions: {}, currentCheckpointId: "2026-07-09T05-04-45-416Z-f99ce6b7" }),
      "utf8",
    );
    const save = await handleRequest(
      memory,
      cwd,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "memory_save",
          arguments: { text: "Provenance survives when the checkpoint row exists.", kind: "semantic", importance: 7 },
        },
      }),
    );
    const saveResult = JSON.parse((save?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");
    const row = memory.db
      .prepare("SELECT source_checkpoint_id FROM memory_items WHERE id = ?")
      .get(saveResult.id) as { source_checkpoint_id: string | null };
    assert.equal(row.source_checkpoint_id, "2026-07-09T05-04-45-416Z-f99ce6b7");
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

test("tools/call memory_search records a disclosure savings event when previews truncate long text", withSqlite, async () => {
  await withMemory(async (memory, cwd) => {
    memory.db
      .prepare(
        "INSERT INTO memory_items (kind, text, importance, status, created_at, last_reinforced_at) " +
          "VALUES ('semantic', ?, 9, 'active', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z')",
      )
      .run(`The rollout plan is very long. ${"detail ".repeat(100)}`);
    await handleRequest(
      memory,
      cwd,
      JSON.stringify({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "memory_search", arguments: { query: "rollout plan" } },
      }),
    );
    const savings = memory.db
      .prepare("SELECT chars_full, chars_sent FROM savings_events WHERE mechanism = 'disclosure'")
      .get() as { chars_full: number; chars_sent: number } | undefined;
    assert.ok(savings, "a preview shorter than the full hit text should record a disclosure savings event");
    assert.ok(savings.chars_full > savings.chars_sent);
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
  const cwd = await mkdtemp(join(tmpdir(), "mixai-mcp-stdio-"));
  await mkdir(join(cwd, ".mixai"), { recursive: true });
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
