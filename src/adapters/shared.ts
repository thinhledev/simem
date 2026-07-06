import type { CommandRunner } from "../process.js";
import type { CredentialStatus, ProviderHealth, ProviderId, ProviderUsage } from "../types.js";

export async function probeVersion(
  runner: CommandRunner,
  command: string,
): Promise<{ available: boolean; version?: string; detail?: string }> {
  const result = await runner.run({ command, args: ["--version"], timeoutMs: 5_000 });
  if (result.exitCode === 0) {
    const version = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/).at(-1);
    return { available: true, ...(version ? { version } : {}) };
  }
  const detail = result.error?.message || result.stderr.trim() || `${command} exited with ${String(result.exitCode)}`;
  return { available: false, detail };
}

export function makeHealth(
  provider: ProviderId,
  command: string,
  capabilities: ProviderHealth["capabilities"],
  available: boolean,
  authenticated: boolean,
  credential: CredentialStatus,
  extra: { version?: string; detail?: string } = {},
): ProviderHealth {
  return {
    provider,
    command,
    capabilities,
    available,
    authenticated,
    credential,
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

export function getTextContent(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type?: string; text?: string } => Boolean(item && typeof item === "object"))
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("");
}

export function findToolName(raw: Record<string, unknown>): string | undefined {
  const toolCall = raw.tool_call;
  if (!toolCall || typeof toolCall !== "object") return undefined;
  return Object.keys(toolCall).at(0);
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

// Extracts token usage from a provider event, tolerating each CLI's field
// spellings. Claude's `result` event carries usage.input_tokens/output_tokens/
// cache_read_input_tokens/cache_creation_input_tokens plus a top-level
// total_cost_usd (verified against a live stream-json capture); Codex's
// `turn.completed` carries usage.input_tokens and friends; Cursor often
// reports nothing — an absent field simply stays undefined, and a fully
// empty extraction returns undefined rather than {}.
export function extractUsage(raw: Record<string, unknown>): ProviderUsage | undefined {
  const usageRecord =
    raw.usage && typeof raw.usage === "object" && !Array.isArray(raw.usage)
      ? (raw.usage as Record<string, unknown>)
      : undefined;
  const inputTokens = usageRecord ? firstNumber(usageRecord, ["input_tokens", "prompt_tokens"]) : undefined;
  const outputTokens = usageRecord ? firstNumber(usageRecord, ["output_tokens", "completion_tokens"]) : undefined;
  const cacheReadTokens = usageRecord
    ? firstNumber(usageRecord, ["cache_read_input_tokens", "cached_input_tokens", "cache_read_tokens"])
    : undefined;
  const cacheCreationTokens = usageRecord
    ? firstNumber(usageRecord, ["cache_creation_input_tokens", "cache_write_tokens"])
    : undefined;
  const costUsd = firstNumber(raw, ["total_cost_usd", "cost_usd"]);
  const usage: ProviderUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}
