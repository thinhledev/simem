import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { parseArgs } from "../src/cli.js";

test("merges provider overrides without dropping defaults", () => {
  const config = mergeConfig({ providers: { cursor: { command: "agent", credentialTier: "free" } } });
  assert.equal(config.providers.cursor.command, "agent");
  assert.equal(config.providers.cursor.credentialTier, "free");
  assert.equal(config.providers.codex.command, "codex");
});

test("antigravity is enabled by default, for status visibility, but excluded from default routing order", () => {
  const config = mergeConfig();
  assert.equal(config.providers.antigravity.enabled, true);
  assert.equal(config.providers.antigravity.command, "agy");
  assert.equal(config.routing.providers.includes("antigravity"), false);
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

test("config.example.json matches the real defaults and loads cleanly", async () => {
  const { readFile } = await import("node:fs/promises");
  const example = JSON.parse(await readFile(new URL("../config.example.json", import.meta.url), "utf8"));
  const merged = mergeConfig(example);
  assert.deepEqual(merged.memory, DEFAULT_CONFIG.memory);
  assert.deepEqual(merged.compression, DEFAULT_CONFIG.compression);
  assert.deepEqual(merged.mcp, DEFAULT_CONFIG.mcp);
});
