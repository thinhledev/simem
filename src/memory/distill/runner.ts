import type { MemoryConfig } from "../../config.js";
import type { GatewayRunResult, RunRequest } from "../../types.js";
import type { MemoryDb } from "../db.js";
import { recordGatewayAttempts, type LedgerPurpose } from "../ledger.js";
import { detectOllamaChatModel } from "./ollama.js";

// Tier 3: a remote coding-agent CLI (`codex exec`, `claude -p`) through the
// orchestrator. Spends the user's provider tokens, so it is opt-in only.
// GatewayOrchestrator satisfies it; tests fake it with an object literal.
export interface ConsolidationRunner {
  run(request: RunRequest, options?: { onEvent?: unknown }): Promise<GatewayRunResult>;
}

// Tier 2: a model running on this machine (Ollama). Costs no provider tokens.
export interface LocalDistillModel {
  readonly local: true;
  readonly label: string;
  generate(prompt: string, timeoutMs: number): Promise<string>;
}

/** The optional LLM tier on top of the always-on rules tier. */
export type DistillRunner = ConsolidationRunner | LocalDistillModel;

export function isLocalModel(runner: DistillRunner): runner is LocalDistillModel {
  return "local" in runner && runner.local === true;
}

export interface DistillCall {
  output?: string;
  /** Why no output was produced, when it wasn't. */
  detail?: string;
}

// One call into whichever LLM tier is configured. Remote calls are recorded in
// the spend ledger; local calls cost nothing and are not.
export async function runDistill(
  memory: MemoryDb,
  runner: DistillRunner,
  input: { purpose: LedgerPurpose; checkpointId?: string; prompt: string; cwd: string; timeoutMs: number },
): Promise<DistillCall> {
  if (isLocalModel(runner)) {
    try {
      const output = (await runner.generate(input.prompt, input.timeoutMs)).trim();
      return output ? { output } : { detail: `${runner.label} returned no output` };
    } catch (error) {
      return { detail: error instanceof Error ? error.message : String(error) };
    }
  }
  const result = await runner.run({ prompt: input.prompt, cwd: input.cwd, accessMode: "read-only", timeoutMs: input.timeoutMs });
  recordGatewayAttempts(memory, input.purpose, input.checkpointId, input.prompt.length, result);
  if (result.ok && result.result?.output.trim()) return { output: result.result.output };
  const detail =
    result.attempts.length === 0 ? "no provider ready" : result.attempts.at(-1)?.result.error ?? "provider run failed";
  return { detail };
}

// Picks the optional LLM tier. Default config returns undefined: rules only,
// zero provider tokens. The remote factory is only invoked when opted in.
export async function selectDistillRunner(
  config: MemoryConfig,
  remote: () => ConsolidationRunner,
): Promise<DistillRunner | undefined> {
  if (config.distill.remote) return remote();
  if (config.distill.ollamaModel) {
    return await detectOllamaChatModel(config.embeddings.ollamaUrl, config.distill.ollamaModel);
  }
  return undefined;
}
