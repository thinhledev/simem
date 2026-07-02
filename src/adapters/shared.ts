import type { CommandRunner } from "../process.js";
import type { CredentialStatus, ProviderHealth, ProviderId } from "../types.js";

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
