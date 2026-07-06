export const PROVIDER_IDS = ["codex", "claude", "cursor", "antigravity"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

// Desktop app bundle name, without the ".app" suffix. Shared by preflight
// (Applications lookup), the switcher (`open -a`), and CLI display text so
// they cannot drift out of sync per-provider.
export const PROVIDER_APP_NAME: Record<ProviderId, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

export const CREDENTIAL_TIERS = ["paid", "included", "free", "unknown"] as const;
export type CredentialTier = (typeof CREDENTIAL_TIERS)[number];

export const FAILURE_KINDS = [
  "auth",
  "quota",
  "rate-limit",
  "unavailable",
  "timeout",
  "invalid-request",
  "permission",
  "provider",
  "unknown",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export type AccessMode = "read-only" | "workspace-write";

export interface CredentialStatus {
  tier: CredentialTier;
  source: string;
  detail?: string;
}

export interface ProviderCapabilities {
  structuredEvents: boolean;
  resumableSessions: boolean;
  workspaceEdits: boolean;
  protocol: "cli-jsonl" | "acp";
}

export interface ProviderHealth {
  provider: ProviderId;
  available: boolean;
  authenticated: boolean;
  command: string;
  version?: string;
  credential: CredentialStatus;
  capabilities: ProviderCapabilities;
  checkedAt: string;
  detail?: string;
}

export interface RunRequest {
  prompt: string;
  cwd: string;
  accessMode: AccessMode;
  timeoutMs: number;
  model?: string;
  sessionId?: string;
}

export type NormalizedEventType =
  | "run.started"
  | "session.started"
  | "assistant.delta"
  | "tool.started"
  | "tool.completed"
  | "run.completed"
  | "run.failed";

export interface NormalizedEvent {
  type: NormalizedEventType;
  provider: ProviderId;
  at: string;
  sessionId?: string;
  text?: string;
  toolName?: string;
  raw?: unknown;
}

// Token/cost usage as reported by the provider CLI's own stream output.
// Every field is optional: an absent field means the provider did not report
// it (common for Cursor), and callers fall back to character-based estimates.
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
}

export interface ProviderRunResult {
  provider: ProviderId;
  ok: boolean;
  output: string;
  events: NormalizedEvent[];
  durationMs: number;
  exitCode: number | null;
  sessionId?: string;
  failure?: FailureKind;
  error?: string;
  usage?: ProviderUsage;
}

export interface GatewayAttempt {
  provider: ProviderId;
  credential: CredentialStatus;
  result: ProviderRunResult;
}

export interface GatewayRunResult {
  runId: string;
  ok: boolean;
  attempts: GatewayAttempt[];
  result?: ProviderRunResult;
}

export type EventHandler = (event: NormalizedEvent) => void;
