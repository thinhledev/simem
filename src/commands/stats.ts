import type { GatewayConfig } from "../config.js";
import { openMemoryDb } from "../memory/db.js";
import { collectStats, formatStats } from "../stats/stats.js";
import { resolveProject } from "../store/project.js";
import { parseSince, print, type Output } from "./common.js";

export async function runStats(options: Output & { cwd: string; config: GatewayConfig; since?: string; groupBy?: string }): Promise<void> {
  const memory = await openMemoryDb(options.cwd, { quiet: true });
  if (!memory) throw new Error(`Memory requires Node.js >= 22.5; this is ${process.version}`);
  try {
    const since = parseSince(options.since)?.toISOString();
    const groupBy = (["agent", "surface", "day", "session"] as const).find((value) => value === options.groupBy);
    const stats = collectStats(memory, { ...(since ? { since } : {}), ...(groupBy ? { groupBy } : {}) });
    print(options, formatStats(stats, resolveProject(options.cwd).name), stats);
  } finally {
    memory.close();
  }
}
