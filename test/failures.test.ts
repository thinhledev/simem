import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure } from "../src/failures.js";
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
