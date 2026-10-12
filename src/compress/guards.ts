import type { GatewayConfig } from "../config.js";
import type { RawHookInput } from "../handoff/hooks.js";
import type { ProviderId } from "../types.js";

// Placeholder until the guards land; returning undefined defers to the host.
export async function decidePreToolUse(
  _input: RawHookInput,
  _cwd: string,
  _provider: ProviderId,
  _config: GatewayConfig,
): Promise<Record<string, unknown> | undefined> {
  return undefined;
}
