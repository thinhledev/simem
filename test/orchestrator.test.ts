import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig } from "../src/config.js";
import { GatewayOrchestrator } from "../src/orchestrator.js";
import type { ProviderAdapter } from "../src/adapters/adapter.js";
import type { FailureKind, ProviderHealth, ProviderId, ProviderRunResult, RunRequest } from "../src/types.js";

function adapter(id: ProviderId, tier: ProviderHealth["credential"]["tier"], outcome: { ok: boolean; failure?: FailureKind }): ProviderAdapter {
  const health: ProviderHealth = {
    provider: id,
    available: true,
    authenticated: true,
    command: id,
    credential: { tier, source: "test" },
    capabilities: { structuredEvents: true, resumableSessions: true, workspaceEdits: true, protocol: "cli-jsonl" },
    checkedAt: new Date(0).toISOString(),
  };
  return {
    id,
    command: id,
    capabilities: health.capabilities,
    async health() { return health; },
    async run(_request: RunRequest): Promise<ProviderRunResult> {
      return {
        provider: id,
        ok: outcome.ok,
        output: outcome.ok ? `${id} result` : "",
        events: [],
        durationMs: 1,
        exitCode: outcome.ok ? 0 : 1,
        ...(outcome.failure ? { failure: outcome.failure, error: outcome.failure } : {}),
      };
    },
  };
}

const request: RunRequest = { prompt: "test", cwd: "/tmp", accessMode: "read-only", timeoutMs: 100 };

test("falls back on quota errors and stops after success", async () => {
  const adapters = new Map<ProviderId, ProviderAdapter>([
    ["codex", adapter("codex", "paid", { ok: false, failure: "quota" })],
    ["claude", adapter("claude", "included", { ok: true })],
  ]);
  const result = await new GatewayOrchestrator(mergeConfig(), adapters).run(request);
  assert.equal(result.ok, true);
  assert.deepEqual(result.attempts.map((item) => item.provider), ["codex", "claude"]);
});

test("does not hide permission errors behind another provider", async () => {
  const adapters = new Map<ProviderId, ProviderAdapter>([
    ["codex", adapter("codex", "paid", { ok: false, failure: "permission" })],
    ["claude", adapter("claude", "included", { ok: true })],
  ]);
  const result = await new GatewayOrchestrator(mergeConfig(), adapters).run(request);
  assert.equal(result.ok, false);
  assert.deepEqual(result.attempts.map((item) => item.provider), ["codex"]);
});
