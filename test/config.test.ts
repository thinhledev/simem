import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig } from "../src/config.js";

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
