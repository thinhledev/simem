import assert from "node:assert/strict";
import test from "node:test";
import { AntigravityAdapter } from "../src/adapters/antigravity.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { CursorAdapter } from "../src/adapters/cursor.js";
import type { CommandResult, CommandRunner, CommandSpec, LineHandler } from "../src/process.js";
import type { RunRequest } from "../src/types.js";

class FakeRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];
  constructor(private readonly lines: string[]) {}

  async run(spec: CommandSpec, onLine?: LineHandler): Promise<CommandResult> {
    this.calls.push(spec);
    for (const line of this.lines) onLine?.(line);
    return { exitCode: 0, stdout: `${this.lines.join("\n")}\n`, stderr: "", durationMs: 12, timedOut: false };
  }
}

const REQUEST: RunRequest = {
  prompt: "Inspect the project",
  cwd: "/tmp/project",
  accessMode: "read-only",
  timeoutMs: 1_000,
};

test("Codex adapter normalizes JSONL and preserves its thread id", async () => {
  const runner = new FakeRunner([
    JSON.stringify({ type: "thread.started", thread_id: "codex-session" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex result" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
  ]);
  const result = await new CodexAdapter(runner, { command: "codex" }).run(REQUEST);
  assert.equal(result.ok, true);
  assert.equal(result.output, "Codex result");
  assert.equal(result.sessionId, "codex-session");
  assert.deepEqual(runner.calls[0]?.args?.slice(0, 3), ["exec", "--json", "--color"]);
});

test("Codex adapter extracts usage from turn.completed, and reports none when absent", async () => {
  const withUsage = new FakeRunner([
    JSON.stringify({ type: "thread.started", thread_id: "s" }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 120, output_tokens: 40, cached_input_tokens: 30 },
    }),
  ]);
  const withUsageResult = await new CodexAdapter(withUsage, { command: "codex" }).run(REQUEST);
  assert.deepEqual(withUsageResult.usage, { inputTokens: 120, outputTokens: 40, cacheReadTokens: 30 });

  const withoutUsage = new FakeRunner([JSON.stringify({ type: "thread.started", thread_id: "s" })]);
  const withoutUsageResult = await new CodexAdapter(withoutUsage, { command: "codex" }).run(REQUEST);
  assert.equal(withoutUsageResult.usage, undefined);
});

test("Claude adapter uses plan mode for read-only work", async () => {
  const runner = new FakeRunner([
    JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }),
    JSON.stringify({ type: "assistant", session_id: "claude-session", message: { content: [{ type: "text", text: "Working" }] } }),
    JSON.stringify({ type: "result", session_id: "claude-session", result: "Claude result" }),
  ]);
  const result = await new ClaudeAdapter(runner, { command: "claude" }).run(REQUEST);
  assert.equal(result.output, "Claude result");
  assert.equal(result.sessionId, "claude-session");
  assert.ok(runner.calls[0]?.args?.includes("plan"));
});

test("Claude adapter extracts usage and cost from the result event, and reports none when absent", async () => {
  const withUsage = new FakeRunner([
    JSON.stringify({
      type: "result",
      session_id: "s",
      result: "done",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    }),
  ]);
  const withUsageResult = await new ClaudeAdapter(withUsage, { command: "claude" }).run(REQUEST);
  assert.deepEqual(withUsageResult.usage, {
    inputTokens: 500,
    outputTokens: 80,
    cacheReadTokens: 10,
    cacheCreationTokens: 5,
    costUsd: 0.0123,
  });

  const withoutUsage = new FakeRunner([JSON.stringify({ type: "result", session_id: "s", result: "done" })]);
  const withoutUsageResult = await new ClaudeAdapter(withoutUsage, { command: "claude" }).run(REQUEST);
  assert.equal(withoutUsageResult.usage, undefined);
});

test("Cursor adapter only adds force in workspace-write mode", async () => {
  const runner = new FakeRunner([
    JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-session" }),
    JSON.stringify({ type: "result", session_id: "cursor-session", result: "Cursor result" }),
  ]);
  const adapter = new CursorAdapter(runner, { command: "cursor-agent" });
  await adapter.run(REQUEST);
  await adapter.run({ ...REQUEST, accessMode: "workspace-write" });
  assert.equal(runner.calls[0]?.args?.includes("--force"), false);
  assert.equal(runner.calls[1]?.args?.includes("--force"), true);
});

test("Cursor adapter reports no usage when the CLI doesn't report any (common case)", async () => {
  const runner = new FakeRunner([JSON.stringify({ type: "result", session_id: "s", result: "done" })]);
  const result = await new CursorAdapter(runner, { command: "cursor-agent" }).run(REQUEST);
  assert.equal(result.usage, undefined);
});

class VersionProbeRunner implements CommandRunner {
  constructor(private readonly outcome: { available: true; version: string } | { available: false }) {}
  async run(spec: CommandSpec): Promise<CommandResult> {
    if (!this.outcome.available) {
      const error = new Error(`spawn ${spec.command} ENOENT`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return { exitCode: null, stdout: "", stderr: "", durationMs: 1, timedOut: false, error };
    }
    return { exitCode: 0, stdout: this.outcome.version, stderr: "", durationMs: 1, timedOut: false };
  }
}

test("Antigravity adapter reports ready when the agy CLI is installed, without requiring an API key", async () => {
  const adapter = new AntigravityAdapter(new VersionProbeRunner({ available: true, version: "1.0.16" }), {
    command: "agy",
  });
  const health = await adapter.health();
  assert.equal(health.available, true);
  assert.equal(health.authenticated, true);
  assert.equal(health.version, "1.0.16");
  assert.equal(health.credential.source, "agy CLI");
});

test("Antigravity adapter reports not ready with an actionable detail when agy is missing", async () => {
  const adapter = new AntigravityAdapter(new VersionProbeRunner({ available: false }), { command: "agy" });
  const health = await adapter.health();
  assert.equal(health.available, false);
  assert.equal(health.authenticated, false);
  assert.match(health.detail ?? "", /ENOENT/);
});

test("Antigravity adapter's run() always fails cleanly instead of throwing", async () => {
  const adapter = new AntigravityAdapter(new VersionProbeRunner({ available: true, version: "1.0.16" }), {
    command: "agy",
  });
  const result = await adapter.run(REQUEST);
  assert.equal(result.ok, false);
  assert.equal(result.failure, "unavailable");
  assert.match(result.error ?? "", /mixai switch antigravity --surface interactive/);
});
