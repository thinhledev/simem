import type { GatewayConfig } from "../config.js";
import type { CommandRunner } from "../process.js";
import type { ProviderId } from "../types.js";
import type { ProviderAdapter } from "./adapter.js";
import { AntigravityAdapter } from "./antigravity.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";

export function createAdapters(config: GatewayConfig, runner: CommandRunner): Map<ProviderId, ProviderAdapter> {
  const adapters = new Map<ProviderId, ProviderAdapter>();
  const codex = config.providers.codex;
  const claude = config.providers.claude;
  const cursor = config.providers.cursor;
  const antigravity = config.providers.antigravity;

  if (codex.enabled) {
    adapters.set(
      "codex",
      new CodexAdapter(runner, {
        command: codex.command ?? "codex",
        ...(codex.model ? { model: codex.model } : {}),
        ...(codex.credentialTier ? { credentialTier: codex.credentialTier } : {}),
      }),
    );
  }
  if (claude.enabled) {
    adapters.set(
      "claude",
      new ClaudeAdapter(runner, {
        command: claude.command ?? "claude",
        ...(claude.model ? { model: claude.model } : {}),
        ...(claude.credentialTier ? { credentialTier: claude.credentialTier } : {}),
      }),
    );
  }
  if (cursor.enabled) {
    adapters.set(
      "cursor",
      new CursorAdapter(runner, {
        command: cursor.command ?? "cursor-agent",
        ...(cursor.model ? { model: cursor.model } : {}),
        ...(cursor.credentialTier ? { credentialTier: cursor.credentialTier } : {}),
      }),
    );
  }
  if (antigravity.enabled) {
    adapters.set(
      "antigravity",
      new AntigravityAdapter(runner, {
        command: antigravity.command ?? "agy",
        ...(antigravity.model ? { model: antigravity.model } : {}),
        ...(antigravity.credentialTier ? { credentialTier: antigravity.credentialTier } : {}),
      }),
    );
  }
  return adapters;
}
