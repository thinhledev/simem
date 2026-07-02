import { randomUUID } from "node:crypto";
import type { GatewayConfig } from "./config.js";
import { planRoute } from "./router.js";
import type { ProviderAdapter } from "./adapters/adapter.js";
import type {
  EventHandler,
  GatewayRunResult,
  ProviderHealth,
  ProviderId,
  RunRequest,
} from "./types.js";

export class GatewayOrchestrator {
  constructor(
    private readonly config: GatewayConfig,
    private readonly adapters: Map<ProviderId, ProviderAdapter>,
  ) {}

  async status(): Promise<ProviderHealth[]> {
    return await Promise.all([...this.adapters.values()].map(async (adapter) => await adapter.health()));
  }

  async run(
    request: RunRequest,
    options: { provider?: ProviderId; onEvent?: EventHandler } = {},
  ): Promise<GatewayRunResult> {
    const runId = randomUUID();
    const health = await this.status();
    const route = planRoute(health, this.config, options.provider);
    const attempts: GatewayRunResult["attempts"] = [];

    for (const candidate of route.candidates) {
      const adapter = this.adapters.get(candidate.provider);
      if (!adapter) continue;
      const result = await adapter.run(request, options.onEvent);
      attempts.push({ provider: candidate.provider, credential: candidate.credential, result });
      if (result.ok) return { runId, ok: true, attempts, result };
      if (options.provider || !result.failure || !this.config.routing.fallbackOn.includes(result.failure)) break;
    }
    return { runId, ok: false, attempts };
  }
}
