import { homedir } from "node:os";
import { relative } from "node:path";

export interface Output {
  json: boolean;
  quiet?: boolean;
}

export function print(out: Output, human: string, json?: unknown): void {
  if (out.json) process.stdout.write(`${JSON.stringify(json ?? { message: human })}\n`);
  else if (!out.quiet) process.stdout.write(human.endsWith("\n") ? human : `${human}\n`);
}

// "90d", "12h", "30m", or an ISO date.
export function parseSince(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d+)([dhm])$/.exec(value.trim());
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2] === "d" ? 86_400_000 : match[2] === "h" ? 3_600_000 : 60_000;
    return new Date(Date.now() - amount * unit);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--since must look like 90d, 12h, 30m, or an ISO date (got ${value})`);
  return date;
}

export function displayPath(path: string, cwd?: string): string {
  if (cwd) {
    const rel = relative(cwd, path);
    if (rel && !rel.startsWith("..")) return rel;
  }
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
