import type { GatewayConfig } from "./config.js";
import type { ProviderHealth, ProviderId } from "./types.js";

export interface RoutePlan {
  candidates: ProviderHealth[];
  skipped: ProviderHealth[];
}

export function planRoute(
  health: ProviderHealth[],
  config: GatewayConfig,
  requestedProvider?: ProviderId,
): RoutePlan {
  const enabled = health.filter((item) => config.routing.providers.includes(item.provider));
  if (requestedProvider) {
    const selected = enabled.find((item) => item.provider === requestedProvider);
    return {
      candidates: selected?.available && selected.authenticated ? [selected] : [],
      skipped: selected ? enabled.filter((item) => item !== selected).concat(selected.available && selected.authenticated ? [] : [selected]) : enabled,
    };
  }

  const providerRank = new Map(config.routing.providers.map((id, index) => [id, index]));
  const tierRank = new Map(config.routing.credentialOrder.map((tier, index) => [tier, index]));
  const candidates = enabled
    .filter((item) => item.available && item.authenticated)
    .sort((left, right) => {
      const tierDifference = (tierRank.get(left.credential.tier) ?? 999) - (tierRank.get(right.credential.tier) ?? 999);
      if (tierDifference !== 0) return tierDifference;
      return (providerRank.get(left.provider) ?? 999) - (providerRank.get(right.provider) ?? 999);
    });
  return {
    candidates,
    skipped: enabled.filter((item) => !item.available || !item.authenticated),
  };
}
