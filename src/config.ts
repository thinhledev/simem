import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CREDENTIAL_TIERS,
  FAILURE_KINDS,
  PROVIDER_IDS,
  type CredentialTier,
  type FailureKind,
  type ProviderId,
} from "./types.js";

export interface ProviderConfig {
  enabled: boolean;
  command?: string;
  model?: string;
  credentialTier?: CredentialTier;
}

export interface GatewayConfig {
  routing: {
    providers: ProviderId[];
    credentialOrder: CredentialTier[];
    fallbackOn: FailureKind[];
  };
  providers: Record<ProviderId, ProviderConfig>;
}

export const DEFAULT_CONFIG: GatewayConfig = {
  routing: {
    providers: ["codex", "claude", "cursor"],
    credentialOrder: ["paid", "included", "free", "unknown"],
    fallbackOn: ["auth", "quota", "rate-limit", "unavailable", "timeout", "provider"],
  },
  providers: {
    codex: { enabled: true, command: "codex" },
    claude: { enabled: true, command: "claude" },
    cursor: { enabled: true },
  },
};

type PartialConfig = {
  routing?: {
    providers?: unknown;
    credentialOrder?: unknown;
    fallbackOn?: unknown;
  };
  providers?: Partial<Record<ProviderId, Partial<ProviderConfig>>>;
};

function enumArray<T extends string>(value: unknown, allowed: readonly T[], field: string): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => !allowed.includes(item as T))) {
    throw new Error(`${field} must contain only: ${allowed.join(", ")}`);
  }
  return [...new Set(value as T[])];
}

export function mergeConfig(input: PartialConfig = {}): GatewayConfig {
  const providerOrder = enumArray(input.routing?.providers, PROVIDER_IDS, "routing.providers");
  const credentialOrder = enumArray(
    input.routing?.credentialOrder,
    CREDENTIAL_TIERS,
    "routing.credentialOrder",
  );
  const fallbackOn = enumArray(input.routing?.fallbackOn, FAILURE_KINDS, "routing.fallbackOn");

  const providers = Object.fromEntries(
    PROVIDER_IDS.map((id) => {
      const override = input.providers?.[id] ?? {};
      if (override.enabled !== undefined && typeof override.enabled !== "boolean") {
        throw new Error(`providers.${id}.enabled must be a boolean`);
      }
      if (override.command !== undefined && typeof override.command !== "string") {
        throw new Error(`providers.${id}.command must be a string`);
      }
      if (
        override.credentialTier !== undefined &&
        !CREDENTIAL_TIERS.includes(override.credentialTier)
      ) {
        throw new Error(`providers.${id}.credentialTier is invalid`);
      }
      return [id, { ...DEFAULT_CONFIG.providers[id], ...override }];
    }),
  ) as Record<ProviderId, ProviderConfig>;

  return {
    routing: {
      providers: providerOrder ?? [...DEFAULT_CONFIG.routing.providers],
      credentialOrder: credentialOrder ?? [...DEFAULT_CONFIG.routing.credentialOrder],
      fallbackOn: fallbackOn ?? [...DEFAULT_CONFIG.routing.fallbackOn],
    },
    providers,
  };
}

export async function loadConfig(path?: string): Promise<GatewayConfig> {
  const configPath = resolve(path ?? "gateway.config.json");
  try {
    const raw = await readFile(configPath, "utf8");
    return mergeConfig(JSON.parse(raw) as PartialConfig);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (!path && nodeError.code === "ENOENT") return mergeConfig();
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${configPath}: ${error.message}`);
    throw error;
  }
}
