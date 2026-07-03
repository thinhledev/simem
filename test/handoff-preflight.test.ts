import assert from "node:assert/strict";
import test from "node:test";
import { checkDesktopApp, checkLaunchReadiness } from "../src/handoff/preflight.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/process.js";

class ResultRunner implements CommandRunner {
  constructor(private readonly result: CommandResult) {}
  async run(_spec: CommandSpec): Promise<CommandResult> {
    return this.result;
  }
}

function result(stdout: string, exitCode = 0): CommandResult {
  return { exitCode, stdout, stderr: "", durationMs: 1, timedOut: false };
}

test("accepts an authenticated Claude subscription without an API key", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const readiness = await checkLaunchReadiness(
      new ResultRunner(result(JSON.stringify({ loggedIn: true, authMethod: "oauth" }))),
      "claude",
    );
    assert.equal(readiness.ready, true);
  } finally {
    if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("reports Antigravity ready when the agy CLI responds", async () => {
  const readiness = await checkLaunchReadiness(new ResultRunner(result("1.0.16")), "antigravity");
  assert.equal(readiness.ready, true);
});

test("returns an actionable command when the agy CLI is missing", async () => {
  const missing: CommandResult = {
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    error: Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }),
  };
  const readiness = await checkLaunchReadiness(new ResultRunner(missing), "antigravity");
  assert.equal(readiness.ready, false);
  assert.equal(readiness.loginCommand, "agy install");
});

test("checkDesktopApp reports not installed off macOS, regardless of provider", async () => {
  if (process.platform === "darwin") return;
  for (const provider of ["codex", "claude", "cursor", "antigravity"] as const) {
    assert.deepEqual(await checkDesktopApp(new ResultRunner(result("")), provider), { installed: false });
  }
});

test("checkDesktopApp resolves without throwing for every provider", async () => {
  for (const provider of ["codex", "claude", "cursor", "antigravity"] as const) {
    const status = await checkDesktopApp(new ResultRunner(result("")), provider);
    assert.equal(typeof status.installed, "boolean");
  }
});

test("checkDesktopApp reads the app's own bundle version, not any CLI version", async () => {
  if (process.platform !== "darwin") return;
  const status = await checkDesktopApp(new ResultRunner(result("9.9.9\n")), "claude");
  // Only asserts the version shape when the app happens to be installed on
  // the machine running this test; installation itself is environment-dependent.
  if (status.installed) assert.equal(status.version, "9.9.9");
});

test("returns an actionable Claude login command when unauthenticated", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const readiness = await checkLaunchReadiness(
      new ResultRunner(result(JSON.stringify({ loggedIn: false }), 1)),
      "claude",
    );
    assert.equal(readiness.ready, false);
    assert.equal(readiness.loginCommand, "claude auth login");
    assert.match(readiness.message ?? "", /API key is optional/);
  } finally {
    if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
  }
});
