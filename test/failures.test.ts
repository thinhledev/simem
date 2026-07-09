import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure, compactError } from "../src/failures.js";
import type { CommandResult } from "../src/process.js";

function result(stderr: string, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr,
    durationMs: 1,
    timedOut: false,
    ...overrides,
  };
}

test("classifies failures that are safe to route around", () => {
  assert.equal(classifyFailure(result("429 rate limit exceeded")), "rate-limit");
  assert.equal(classifyFailure(result("credit balance is too low")), "quota");
  assert.equal(classifyFailure(result("invalid API key")), "auth");
  assert.equal(classifyFailure(result("", { timedOut: true })), "timeout");
});

test("distinguishes permission and invalid request failures", () => {
  assert.equal(classifyFailure(result("permission denied")), "permission");
  assert.equal(classifyFailure(result("unknown option --oops")), "invalid-request");
});

test("compactError surfaces the real error line even when a long startup banner pushes it past the last 8 lines", () => {
  // Mirrors Codex's actual shape: "Reading additional input from stdin..."
  // plus ~10 lines of banner (version/workdir/model/etc.) before the real
  // error — a positional tail-slice of the last 8 lines would land entirely
  // inside the banner and never reach the ERROR line below it.
  const banner = [
    "Reading additional input from stdin...",
    "OpenAI Codex v0.142.5",
    "--------",
    "workdir: /repo",
    "model: gpt-5.5",
    "provider: openai",
    "approval: never",
    "sandbox: workspace-write",
    "reasoning effort: xhigh",
    "reasoning summaries: none",
    "session id: abc123",
    "--------",
    "user",
    "Explain the architecture",
  ];
  const stderr = [...banner, "ERROR: You've hit your usage limit. Try again at 8:38 PM."].join("\n");
  // Sanity check: the real error line is NOT among the last 8 lines,
  // proving the old tail-slice approach would have missed it.
  assert.ok(!banner.slice(-7).some((line) => line.includes("ERROR")));
  assert.equal(compactError(result(stderr)), "ERROR: You've hit your usage limit. Try again at 8:38 PM.");
});

test("compactError falls back to the tail slice when nothing matches a known failure pattern", () => {
  const stderr = Array.from({ length: 12 }, (_, index) => `log line ${index}`).join("\n");
  const detail = compactError(result(stderr));
  assert.match(detail, /log line 11$/);
  assert.equal(detail.split("\n").length, 8);
});

test("compactError reports the exit code when there is no output at all", () => {
  assert.equal(compactError(result("", { exitCode: 7 })), "Provider exited with code 7");
});

test("compactError reports the timeout/spawn-error messages directly, unaffected by output content", () => {
  assert.equal(compactError(result("ERROR: usage limit", { timedOut: true })), "Provider command timed out");
  assert.equal(
    compactError(result("", { error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }) })),
    "spawn codex ENOENT",
  );
});
