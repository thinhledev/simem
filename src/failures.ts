import type { CommandResult } from "./process.js";
import type { FailureKind } from "./types.js";

const MATCHERS: Array<[FailureKind, RegExp]> = [
  ["timeout", /timed?\s*out|deadline exceeded|aborted/i],
  ["auth", /unauthenticated|not logged in|authentication|invalid api key|api[_ -]?key.*(?:missing|invalid)|401\b/i],
  ["quota", /quota|credit balance|insufficient credits|usage limit|spending limit|billing/i],
  ["rate-limit", /rate.?limit|too many requests|429\b|overloaded|capacity/i],
  ["permission", /permission denied|not permitted|approval required|workspace trust|403\b/i],
  ["invalid-request", /invalid request|bad request|unknown (?:option|argument)|400\b/i],
  ["unavailable", /not found|enoent|could not resolve host|connection refused|network is unreachable/i],
  ["provider", /internal server error|service unavailable|502\b|503\b|504\b/i],
];

export function classifyFailure(result: CommandResult): FailureKind {
  if (result.timedOut) return "timeout";
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return "unavailable";
  const text = `${result.stderr}\n${result.stdout}\n${result.error?.message ?? ""}`;
  for (const [kind, pattern] of MATCHERS) {
    if (pattern.test(text)) return kind;
  }
  return "unknown";
}

export function compactError(result: CommandResult): string {
  if (result.timedOut) return "Provider command timed out";
  if (result.error) return result.error.message;
  const text = result.stderr.trim() || result.stdout.trim();
  const lastLines = text.split(/\r?\n/).slice(-8).join("\n");
  return lastLines || `Provider exited with code ${String(result.exitCode)}`;
}
