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
  const combined = `${result.stderr}\n${result.stdout}`;
  const lines = combined.split(/\r?\n/).filter((line) => line.trim());
  // Prefer the line(s) that actually explain the failure over blind
  // positional tail-slicing. Providers print a startup banner before the
  // real error (Codex always prints "Reading additional input from
  // stdin..." first, then version/workdir/model, then the actual error) —
  // depending on exact process-exit timing, a tail slice can land on that
  // banner text and surface it instead of the real message. Reusing
  // MATCHERS keeps the shown detail consistent with why classifyFailure
  // picked the failure kind it did.
  const matched = lines.filter((line) => MATCHERS.some(([, pattern]) => pattern.test(line)));
  if (matched.length > 0) return matched.slice(-4).join("\n");
  const lastLines = lines.slice(-8).join("\n");
  return lastLines || `Provider exited with code ${String(result.exitCode)}`;
}
