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

export interface MemoryBudgetConfig {
  totalChars: number;
  verbatimChars: number;
  semanticChars: number;
  retrievedChars: number;
  digestChars: number;
}

export interface MemoryScoringConfig {
  recencyWeight: number;
  importanceWeight: number;
  relevanceWeight: number;
  halfLifeDays: number;
}

export interface MemoryEmbeddingsConfig {
  enabled: boolean;
  ollamaUrl: string;
  model: string;
}

// Behavior of `mixai hook` when a host agent's lifecycle hooks call in.
// Everything here is about what gets INJECTED into the agent's context, so it
// lives under `memory` rather than as a new top-level section.
export interface MemoryHooksConfig {
  /** Prepend relevant memory previews to every user prompt (UserPromptSubmit hooks). */
  perPromptInjection: boolean;
  /** Character cap for the per-prompt injection block. */
  perPromptMaxChars: number;
  /** Emit a revival brief on session-start after compact/resume/clear. */
  sessionStartBrief: boolean;
  /** Character cap for the session-start revival brief. */
  briefMaxChars: number;
  /** Report cumulative measured savings on `mixai hook stop` and after `mixai run` completes. */
  taskCompletionSavings: boolean;
}

// Who turns raw checkpoints into memory items and summaries. Deterministic
// rules always run; the LLM tiers below are optional extras on top of them.
export interface MemoryDistillConfig {
  /** Also send checkpoints to a remote agent CLI (codex/claude). Spends provider tokens; off by default. */
  remote: boolean;
  /** Also use this Ollama chat model (e.g. "qwen2.5:3b") when it is pulled. Empty disables the local tier. */
  ollamaModel: string;
}

export interface MemoryConfig {
  enabled: boolean;
  verbatimCheckpoints: number;
  epochSize: number;
  projectDigestEpochs: number;
  consolidationTokenCapChars: number;
  consolidationTimeoutMs: number;
  queueDrainLimit: number;
  /** Cap on how many active memory_items are re-sent in every consolidation prompt. */
  consolidationExistingItemsLimit: number;
  /** Per-summary character cap applied inside epoch/project rollup prompts. */
  rollupSummaryCharCap: number;
  budget: MemoryBudgetConfig;
  scoring: MemoryScoringConfig;
  embeddings: MemoryEmbeddingsConfig;
  hooks: MemoryHooksConfig;
  distill: MemoryDistillConfig;
}

export interface GatewayConfig {
  routing: {
    providers: ProviderId[];
    credentialOrder: CredentialTier[];
    fallbackOn: FailureKind[];
  };
  providers: Record<ProviderId, ProviderConfig>;
  memory: MemoryConfig;
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
    // Enabled by default so `mixai status` reports readiness (installed + runnable
    // `agy` CLI). `mixai run --provider antigravity` still fails cleanly: it has
    // no non-interactive execution surface and isn't in the default routing
    // order, so it's never auto-selected. Use `mixai switch --surface interactive`.
    antigravity: { enabled: true, command: "agy" },
  },
  memory: {
    enabled: true,
    verbatimCheckpoints: 8,
    epochSize: 10,
    projectDigestEpochs: 5,
    consolidationTokenCapChars: 16_000,
    consolidationTimeoutMs: 30_000,
    queueDrainLimit: 3,
    consolidationExistingItemsLimit: 80,
    rollupSummaryCharCap: 1_200,
    budget: {
      totalChars: 12_000,
      verbatimChars: 6_000,
      semanticChars: 2_000,
      retrievedChars: 2_000,
      digestChars: 2_000,
    },
    scoring: {
      recencyWeight: 0.2,
      importanceWeight: 0.3,
      relevanceWeight: 0.5,
      halfLifeDays: 30,
    },
    embeddings: {
      enabled: true,
      ollamaUrl: "http://localhost:11434",
      model: "nomic-embed-text",
    },
    hooks: {
      perPromptInjection: true,
      perPromptMaxChars: 600,
      sessionStartBrief: true,
      briefMaxChars: 4_000,
      taskCompletionSavings: true,
    },
    distill: {
      remote: false,
      ollamaModel: "",
    },
  },
};

type PartialConfig = {
  routing?: {
    providers?: unknown;
    credentialOrder?: unknown;
    fallbackOn?: unknown;
  };
  providers?: Partial<Record<ProviderId, Partial<ProviderConfig>>>;
  memory?: unknown;
};

function mergeSection<T extends Record<string, unknown>>(defaults: T, override: unknown, field: string): T {
  if (override === undefined) return { ...defaults };
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    throw new Error(`${field} must be an object`);
  }
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    if (!(key in defaults)) throw new Error(`${field}.${key} is not a recognized option`);
    const defaultValue = defaults[key];
    if (defaultValue && typeof defaultValue === "object" && !Array.isArray(defaultValue)) {
      merged[key] = mergeSection(defaultValue as Record<string, unknown>, value, `${field}.${key}`);
    } else {
      if (typeof value !== typeof defaultValue) {
        throw new Error(`${field}.${key} must be a ${typeof defaultValue}`);
      }
      merged[key] = value;
    }
  }
  return merged as T;
}

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
    memory: mergeSection(
      DEFAULT_CONFIG.memory as unknown as Record<string, unknown>,
      input.memory,
      "memory",
    ) as unknown as MemoryConfig,
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
