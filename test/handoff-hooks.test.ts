import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, type GatewayConfig } from "../src/config.js";
import {
  buildMemoryContextBlock,
  handlePreCompact,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit,
  parseHookInput,
  recordMemoryInjection,
} from "../src/handoff/hooks.js";
import { recordSavings } from "../src/memory/savings.js";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/process.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

class GitRunner implements CommandRunner {
  async run(spec: CommandSpec): Promise<CommandResult> {
    const args = spec.args ?? [];
    let stdout = "";
    if (args[0] === "branch") stdout = "main\n";
    else if (args[0] === "rev-parse") stdout = "abc999\n";
    else if (args[0] === "status") stdout = "## main\n";
    else if (args[0] === "log") stdout = "abc999 tip\n";
    return { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false };
  }
}

function config(overrides?: Partial<GatewayConfig["memory"]["hooks"]> & { memoryEnabled?: boolean }): GatewayConfig {
  return {
    ...DEFAULT_CONFIG,
    memory: {
      ...DEFAULT_CONFIG.memory,
      enabled: overrides?.memoryEnabled ?? true,
      embeddings: { ...DEFAULT_CONFIG.memory.embeddings, enabled: false },
      hooks: {
        ...DEFAULT_CONFIG.memory.hooks,
        ...(overrides?.perPromptInjection !== undefined ? { perPromptInjection: overrides.perPromptInjection } : {}),
        ...(overrides?.sessionStartBrief !== undefined ? { sessionStartBrief: overrides.sessionStartBrief } : {}),
        ...(overrides?.perPromptMaxChars !== undefined ? { perPromptMaxChars: overrides.perPromptMaxChars } : {}),
        ...(overrides?.taskCompletionSavings !== undefined ? { taskCompletionSavings: overrides.taskCompletionSavings } : {}),
      },
    },
  };
}

async function codexTranscriptFixture(workspace: string): Promise<string> {
  const path = join(workspace, "rollout.jsonl");
  await writeFile(
    path,
    [
      { type: "session_meta", payload: { session_id: "codex-hook-1", cwd: workspace, timestamp: "2026-07-06T00:00:00Z" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Refactor the parser" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Parser refactored" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"),
  );
  return path;
}

test("parseHookInput reads claude/codex snake_case fields and tolerates garbage", () => {
  const parsed = parseHookInput(
    JSON.stringify({ source: "compact", session_id: "s-1", transcript_path: "/tmp/t.jsonl", prompt: "fix it", cwd: "/w" }),
  );
  assert.deepEqual(parsed, { source: "compact", sessionId: "s-1", transcriptPath: "/tmp/t.jsonl", prompt: "fix it", cwd: "/w" });
  assert.deepEqual(parseHookInput("not json at all"), {});
  assert.deepEqual(parseHookInput("[1,2,3]"), {});
  // camelCase fallbacks for schemas we can't verify (cursor)
  assert.equal(parseHookInput(JSON.stringify({ sessionId: "c-1" })).sessionId, "c-1");
});

test("session-start emits a brief on compact and clear, nothing on startup, and honors the config gate", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-start-"));
  const runner = new GitRunner();
  const compact = await handleSessionStart({ source: "compact" }, workspace, "codex", config(), runner);
  assert.match(compact, /## Context brief/);
  const clear = await handleSessionStart({ source: "clear" }, workspace, "codex", config(), runner);
  assert.match(clear, /## Context brief/);
  assert.equal(await handleSessionStart({ source: "startup" }, workspace, "codex", config(), runner), "");
  assert.equal(await handleSessionStart({}, workspace, "codex", config(), runner), "");
  assert.equal(
    await handleSessionStart({ source: "compact" }, workspace, "codex", config({ sessionStartBrief: false }), runner),
    "",
  );
});

test("session-start on claude suppresses resume (CLAUDE.local.md import covers it) but still fires on compact", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-claude-"));
  const runner = new GitRunner();
  assert.equal(await handleSessionStart({ source: "resume" }, workspace, "claude", config(), runner), "");
  assert.match(await handleSessionStart({ source: "compact" }, workspace, "claude", config(), runner), /## Context brief/);
  // Other providers have no auto-import, so resume gets the brief.
  assert.match(await handleSessionStart({ source: "resume" }, workspace, "codex", config(), runner), /## Context brief/);
});

test("pre-compact uses the hook-provided transcript path, writes a checkpoint, and spawns detached consolidation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-precompact-"));
  const transcriptPath = await codexTranscriptFixture(workspace);
  const spawned: Array<{ cwd: string; checkpointId: string }> = [];
  await handlePreCompact(
    { transcriptPath, sessionId: "codex-hook-1" },
    workspace,
    "codex",
    config(),
    new GitRunner(),
    (cwd, checkpointId) => spawned.push({ cwd, checkpointId }),
  );
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]?.cwd, workspace);
  const { readFile } = await import("node:fs/promises");
  const handoff = await readFile(join(workspace, ".simem", "current", "HANDOFF.md"), "utf8");
  assert.match(handoff, /Refactor the parser/);
});

test("pre-compact is a silent no-op when no session resolves, and skips consolidation when memory is disabled", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-nosession-"));
  const spawned: string[] = [];
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(workspace, "empty-codex-home");
  try {
    await handlePreCompact({}, workspace, "codex", config(), new GitRunner(), (_, id) => spawned.push(id));
    assert.deepEqual(spawned, []);

    const transcriptPath = await codexTranscriptFixture(workspace);
    await handlePreCompact(
      { transcriptPath },
      workspace,
      "codex",
      config({ memoryEnabled: false }),
      new GitRunner(),
      (_, id) => spawned.push(id),
    );
    assert.deepEqual(spawned, [], "memory disabled: checkpoint yes, consolidation spawn no");
    const { readFile } = await import("node:fs/promises");
    assert.match(await readFile(join(workspace, ".simem", "current", "HANDOFF.md"), "utf8"), /Refactor the parser/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("user-prompt-submit injects capped previews and records an inject ledger row", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-inject-"));
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  memory.db
    .prepare(
      "INSERT INTO memory_items (kind, category, text, importance, status, created_at, last_reinforced_at) " +
        "VALUES ('semantic', 'constraint', 'The parser must reject unterminated strings.', 9, 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
    )
    .run();
  memory.close();

  const output = await handleUserPromptSubmit({ prompt: "parser unterminated strings" }, workspace, "claude", config());
  assert.match(output, /Relevant project memory/);
  assert.match(output, /reject unterminated strings/);
  assert.match(output, /memory_item \d+/);

  const reopened = await openMemoryDb(workspace);
  assert.ok(reopened);
  const row = reopened.db
    .prepare("SELECT purpose, provider, ok, cost_usd FROM llm_calls WHERE purpose = 'inject'")
    .get() as { purpose: string; provider: string; ok: number; cost_usd: number | null };
  reopened.close();
  assert.equal(row.purpose, "inject");
  assert.equal(row.provider, "claude");
  assert.equal(row.ok, 1);
  assert.equal(row.cost_usd, null, "inject rows never claim a dollar cost");
});

test("user-prompt-submit injects for a full natural-language question, not only keyword prompts", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-natural-"));
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  memory.db
    .prepare(
      "INSERT INTO memory_items (kind, category, text, importance, status, created_at, last_reinforced_at) " +
        "VALUES ('semantic', 'constraint', 'The parser must reject unterminated strings.', 9, 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
    )
    .run();
  memory.close();

  const output = await handleUserPromptSubmit(
    { prompt: "why does the parser reject unterminated strings again?" },
    workspace,
    "claude",
    config(),
  );
  assert.match(output, /reject unterminated strings/);
  assert.equal(await handleUserPromptSubmit({ prompt: "yes, continue" }, workspace, "claude", config()), "");
});

test("user-prompt-submit stays silent when disabled, when the prompt is empty, and when nothing matches", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-silent-"));
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  memory.close();

  assert.equal(await handleUserPromptSubmit({ prompt: "x" }, workspace, "claude", config({ perPromptInjection: false })), "");
  assert.equal(await handleUserPromptSubmit({}, workspace, "claude", config()), "");
  assert.equal(await handleUserPromptSubmit({ prompt: "zzz-no-match-anywhere" }, workspace, "claude", config()), "");
});

test("user-prompt-submit respects perPromptMaxChars", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-cap-"));
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  const insert = memory.db.prepare(
    "INSERT INTO memory_items (kind, text, importance, status, created_at, last_reinforced_at) " +
      "VALUES ('semantic', ?, 8, 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
  );
  for (let index = 0; index < 5; index += 1) {
    insert.run(`gateway routing fact number ${index}: ${"detail ".repeat(60)}`);
  }
  memory.close();

  const output = await handleUserPromptSubmit(
    { prompt: "gateway routing" },
    workspace,
    "claude",
    config({ perPromptMaxChars: 200 }),
  );
  assert.ok(output.length <= 200, `injection too long: ${output.length}`);
});

test("stop reports cumulative measured savings when some exist, and stays silent when there are none", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-stop-"));
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  recordSavings(memory, { mechanism: "compaction", charsFull: 4000, charsSent: 400 });
  memory.close();

  const output = await handleStop(workspace, config());
  assert.match(output, /measured savings so far/);
  assert.match(output, /~900 tokens/);
  assert.match(output, /simem memory savings/);

  const emptyWorkspace = await mkdtemp(join(tmpdir(), "simem-hook-stop-empty-"));
  const emptyMemory = await openMemoryDb(emptyWorkspace);
  assert.ok(emptyMemory);
  emptyMemory.close();
  assert.equal(await handleStop(emptyWorkspace, config()), "", "nothing measured yet should stay silent, not print zeroes");
});

test("stop honors the taskCompletionSavings config gate", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-stop-gated-"));
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  recordSavings(memory, { mechanism: "disclosure", charsFull: 1000, charsSent: 100 });
  memory.close();

  assert.equal(await handleStop(workspace, config({ taskCompletionSavings: false })), "");
  assert.equal(await handleStop(workspace, config({ memoryEnabled: false })), "");
});

test("buildMemoryContextBlock returns real hits with a nonzero hitCount, and empty when nothing matches", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-context-"));
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  memory.db
    .prepare(
      "INSERT INTO memory_items (kind, category, text, importance, status, created_at, last_reinforced_at) " +
        "VALUES ('semantic', 'constraint', 'The parser must reject unterminated strings.', 9, 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
    )
    .run();
  memory.close();

  const withHits = await buildMemoryContextBlock(workspace, "parser unterminated strings", config());
  assert.equal(withHits.hitCount, 1);
  assert.match(withHits.block, /reject unterminated strings/);

  const withoutHits = await buildMemoryContextBlock(workspace, "zzz-no-match-anywhere", config());
  assert.deepEqual(withoutHits, { block: "", hitCount: 0 });
});

test("buildMemoryContextBlock never surfaces raw checkpoint messages, only curated memory_items/summaries", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-context-nomsg-"));
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  memory.db
    .prepare(
      "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) " +
        "VALUES ('cp-1', '2026-07-01T00:00:00Z', ?, 'codex', 's', 'export', 'dir', '{}')",
    )
    .run(workspace);
  // Only a raw message matches this query — no memory_items/summaries exist
  // at all. Without excludeMessages, this would surface the user's own past
  // question back at them; with it, there's genuinely nothing to inject.
  memory.db
    .prepare("INSERT INTO messages (checkpoint_id, seq, role, text) VALUES ('cp-1', 0, 'user', 'explain the riskiest module')")
    .run();
  memory.close();

  const result = await buildMemoryContextBlock(workspace, "explain the riskiest module", config());
  assert.deepEqual(result, { block: "", hitCount: 0 }, "a message-only match must not be injected");
});

test("buildMemoryContextBlock honors the perPromptInjection gate and an empty prompt", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-context-gated-"));
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  memory.db
    .prepare(
      "INSERT INTO memory_items (kind, text, importance, status, created_at, last_reinforced_at) " +
        "VALUES ('semantic', 'the gateway retries on 429s', 9, 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
    )
    .run();
  memory.close();

  const disabled = await buildMemoryContextBlock(workspace, "gateway retries", config({ perPromptInjection: false }));
  assert.deepEqual(disabled, { block: "", hitCount: 0 });
  const emptyPrompt = await buildMemoryContextBlock(workspace, "   ", config());
  assert.deepEqual(emptyPrompt, { block: "", hitCount: 0 });
});

test("recordMemoryInjection writes an inject-purpose ledger row attributed to the given provider", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-hook-inject-ledger-"));
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  memory.close();

  await recordMemoryInjection(workspace, "codex", 42, 100, 5);

  const reopened = await openMemoryDb(workspace);
  assert.ok(reopened);
  const row = reopened.db.prepare("SELECT purpose, provider, ok FROM llm_calls WHERE purpose = 'inject'").get() as
    | { purpose: string; provider: string; ok: number }
    | undefined;
  reopened.close();
  assert.equal(row?.purpose, "inject");
  assert.equal(row?.provider, "codex");
  assert.equal(row?.ok, 1);
});
