import assert from "node:assert/strict";
import test from "node:test";
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
