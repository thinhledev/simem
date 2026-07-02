import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig } from "../src/config.js";
import { planRoute } from "../src/router.js";
import type { CredentialTier, ProviderHealth, ProviderId } from "../src/types.js";

function health(provider: ProviderId, tier: CredentialTier, ready = true): ProviderHealth {
  return {
    provider,
    available: ready,
    authenticated: ready,
    command: provider,
    credential: { tier, source: "test" },
    capabilities: {
      structuredEvents: true,
      resumableSessions: true,
      workspaceEdits: true,
      protocol: "cli-jsonl",
    },
    checkedAt: new Date(0).toISOString(),
  };
}

test("routes paid credentials before included and free credentials", () => {
  const plan = planRoute(
    [health("codex", "included"), health("claude", "paid"), health("cursor", "free")],
    mergeConfig(),
  );
  assert.deepEqual(plan.candidates.map((item) => item.provider), ["claude", "codex", "cursor"]);
});

test("uses provider order as the tie breaker", () => {
  const plan = planRoute(
    [health("cursor", "paid"), health("codex", "paid"), health("claude", "paid")],
    mergeConfig(),
  );
  assert.deepEqual(plan.candidates.map((item) => item.provider), ["codex", "claude", "cursor"]);
});

test("does not route to unavailable or unauthenticated providers", () => {
  const plan = planRoute([health("codex", "paid", false), health("claude", "paid")], mergeConfig());
  assert.deepEqual(plan.candidates.map((item) => item.provider), ["claude"]);
  assert.deepEqual(plan.skipped.map((item) => item.provider), ["codex"]);
});
