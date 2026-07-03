import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig } from "../src/config.js";
import { parseArgs } from "../src/cli.js";

test("merges provider overrides without dropping defaults", () => {
  const config = mergeConfig({ providers: { cursor: { command: "agent", credentialTier: "free" } } });
  assert.equal(config.providers.cursor.command, "agent");
  assert.equal(config.providers.cursor.credentialTier, "free");
  assert.equal(config.providers.codex.command, "codex");
});

test("rejects unknown routing values", () => {
  assert.throws(
    () => mergeConfig({ routing: { providers: ["bogus"] } }),
    /routing\.providers/,
  );
});

test("parses switch and fork handoff commands", () => {
  const switching = parseArgs(["switch", "claude", "--from", "codex", "--new", "--no-launch"]);
  assert.equal(switching.target, "claude");
  assert.equal(switching.source, "codex");
  assert.equal(switching.newSession, true);
  assert.equal(switching.launch, false);

  const forking = parseArgs(["fork", "codex", "--from", "claude", "--to-session", "thread-1"]);
  assert.equal(forking.command, "fork");
  assert.equal(forking.targetSessionId, "thread-1");
});
