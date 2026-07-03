import type {
  EventHandler,
  ProviderCapabilities,
  ProviderHealth,
  ProviderRunResult,
  RunRequest,
} from "../types.js";
import { BaseAdapter } from "./adapter.js";
import { makeHealth, probeVersion } from "./shared.js";

// Antigravity has no non-interactive execution surface today: `agy` is a
// full terminal agent with no `--auth status`-style probe, so readiness here
// only confirms the CLI is installed and runnable, the same bar `cag switch
// --surface interactive` already uses. `run()` always fails cleanly so a
// misconfigured `--provider antigravity` degrades instead of crashing.
export class AntigravityAdapter extends BaseAdapter {
  readonly id = "antigravity" as const;
  readonly capabilities: ProviderCapabilities = {
    structuredEvents: false,
    resumableSessions: false,
    workspaceEdits: true,
    protocol: "cli-jsonl",
  };

  async health(): Promise<ProviderHealth> {
    const version = await probeVersion(this.runner, this.command);
    const credential = { tier: this.credentialTier ?? ("unknown" as const), source: "agy CLI" };
    if (!version.available) {
      return makeHealth(this.id, this.command, this.capabilities, false, false, credential, {
        detail: version.detail ?? `${this.command} is not installed`,
      });
    }
    return makeHealth(this.id, this.command, this.capabilities, true, true, credential, {
      ...(version.version ? { version: version.version } : {}),
    });
  }

  async run(request: RunRequest, _onEvent?: EventHandler): Promise<ProviderRunResult> {
    void request;
    return {
      provider: this.id,
      ok: false,
      output: "",
      events: [],
      durationMs: 0,
      exitCode: null,
      failure: "unavailable",
      error: "Antigravity is not wired into `cag run` yet; use `cag switch antigravity --surface interactive` instead.",
    };
  }
}
