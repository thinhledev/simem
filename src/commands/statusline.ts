import { join } from "node:path";
import { applyFile, isRecord, jsonTransform, type IntegrationPlan } from "../handoff/integrate.js";
import { readHookInput } from "../handoff/hooks.js";
import { launcherPath } from "../install/launcher.js";
import { openMemoryDb } from "../memory/db.js";
import { homesFor } from "../sources/homes.js";
import { collectStats } from "../stats/stats.js";

// `simem statusline`: Claude Code's status line command. Reads the session
// JSON on stdin, prints one short line, never fails.
export async function runStatusline(fallbackCwd: string): Promise<void> {
  try {
    const raw = await readHookInput(process.stdin);
    const record = raw as unknown as { cwd?: string };
    const cwd = record.cwd ?? fallbackCwd;
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return;
    try {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const stats = collectStats(memory, { since: since.toISOString() });
      const saved = stats.savedTokens >= 1_000 ? `saved ~${(stats.savedTokens / 1000).toFixed(stats.savedTokens >= 10_000 ? 0 : 1)}k tok today · ` : "";
      process.stdout.write(`simem · ${saved}${stats.memory.items} memories\n`);
    } finally {
      memory.close();
    }
  } catch {
    // A status line must never error.
  }
}

function withStatusLine(settings: Record<string, unknown>, remove: boolean): Record<string, unknown> {
  const clone = structuredClone(settings);
  const current = isRecord(clone.statusLine) ? clone.statusLine : undefined;
  const ours = typeof current?.command === "string" && current.command.includes(" statusline");
  if (remove) {
    if (ours) delete clone.statusLine;
    return clone;
  }
  // Never replace a status line the user set up themselves.
  if (current && !ours) return clone;
  clone.statusLine = { type: "command", command: `"${launcherPath()}" statusline` };
  return clone;
}

export async function installStatusline(remove: boolean): Promise<IntegrationPlan[]> {
  const plans: IntegrationPlan[] = [];
  for (const home of homesFor("claude")) {
    const plan: IntegrationPlan = { provider: "claude", files: [], notes: [] };
    const path = join(home.dir, "settings.json");
    await applyFile(plan, path, jsonTransform(path, (existing) => withStatusLine(existing, remove)), {});
    plans.push(plan);
  }
  return plans;
}
