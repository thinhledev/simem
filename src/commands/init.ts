import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayConfig } from "../config.js";
import type { IntegrationPlan } from "../handoff/integrate.js";
import { nodeSupportsSqlite, writeLauncher } from "../install/launcher.js";
import { installUserLevel } from "../install/user-level.js";
import { openMemoryDb } from "../memory/db.js";
import { syncTranscripts } from "../sources/ingest.js";
import { importNativeMemory } from "../sources/native.js";
import { resolveProject } from "../store/project.js";
import { LEGACY_DIR, LEGACY_INTEGRATION_PATTERN } from "../legacy.js";
import { displayPath, print, type Output } from "./common.js";

export interface InitOptions extends Output {
  cwd: string;
  remove: boolean;
  check: boolean;
  noModel: boolean;
  statusline: boolean;
  config: GatewayConfig;
  /** Optional steps added by later subsystems (model download, index, status line). */
  extraSteps?: Array<(context: InitContext) => Promise<string | undefined>>;
}

export interface InitContext {
  cwd: string;
  config: GatewayConfig;
  noModel: boolean;
  statusline: boolean;
  remove: boolean;
}

// Files a 1.x per-project `simem integrate` wrote in this repository. They
// keep working but go silent once the user-level install covers the agent.
function legacyIntegrationFiles(root: string): string[] {
  const candidates = [".claude/settings.json", ".mcp.json", "CLAUDE.local.md", ".codex/hooks.json", ".codex/config.toml", "AGENTS.md", ".cursor/mcp.json", ".cursor/hooks.json"];
  return candidates.filter((relative) => {
    const path = join(root, relative);
    if (!existsSync(path)) return false;
    try {
      return LEGACY_INTEGRATION_PATTERN.test(readFileSync(path, "utf8"));
    } catch {
      return false;
    }
  });
}

function describePlans(plans: IntegrationPlan[], cwd: string): string[] {
  const lines: string[] = [];
  for (const plan of plans) {
    for (const file of plan.files) {
      if (file.action === "unchanged") continue;
      lines.push(`  ${file.action.padEnd(8)} ${displayPath(file.path, cwd)}${file.note ? ` (${file.note})` : ""}`);
    }
    for (const note of plan.notes) lines.push(`  note     ${note}`);
  }
  return lines;
}

export async function runInit(options: InitOptions): Promise<void> {
  if (!nodeSupportsSqlite()) {
    throw new Error(`simem needs Node.js >= 22.5 (built-in SQLite); this is ${process.version}. Upgrade Node, then run simem init again.`);
  }
  if (options.check) {
    const plans = await installUserLevel({ dryRun: true });
    const drift = describePlans(plans, options.cwd);
    print(options, drift.length === 0 ? "simem is installed and up to date for every agent account on this machine." : `simem init would change:\n${drift.join("\n")}`, { drift });
    if (drift.some((line) => !line.includes(" note "))) process.exitCode = 1;
    return;
  }
  if (options.remove) {
    const plans = await installUserLevel({ remove: true });
    const context: InitContext = { cwd: options.cwd, config: options.config, noModel: true, statusline: options.statusline, remove: true };
    for (const step of options.extraSteps ?? []) await step(context);
    print(options, `Removed simem from every agent account:\n${describePlans(plans, options.cwd).join("\n") || "  (nothing was installed)"}\nYour memory in ~/.simem is kept; delete that folder to remove it too.`, { plans });
    return;
  }

  const launcher = writeLauncher();
  const plans = await installUserLevel();
  const lines: string[] = [`Launcher: ${displayPath(launcher)} (pins Node ${process.version} so the desktop apps don't depend on PATH)`];
  const changes = describePlans(plans, options.cwd);
  lines.push(changes.length ? `Installed for every agent account on this machine:\n${changes.join("\n")}` : "Hooks and MCP already up to date for every agent account.");

  const project = resolveProject(options.cwd);
  const memory = await openMemoryDb(options.cwd, { quiet: true });
  memory?.close();
  if (existsSync(join(project.root, LEGACY_DIR, "MIGRATED.txt"))) {
    lines.push(`This project's mixai 1.x memory now lives in ${displayPath(project.storeDir)} (the old .mixai/ files are left untouched).`);
  }
  const legacy = legacyIntegrationFiles(project.root);
  if (legacy.length > 0) {
    lines.push(
      `Found a mixai 1.x per-project setup here (${legacy.join(", ")}). It still calls the old \`mixai\` command, ` +
        "so remove it to avoid running twice: `simem integrate --remove` (it cleans up mixai's entries too), then `npm uninstall -g mixai-cli`.",
    );
  }
  const sync = await syncTranscripts({ cwd: options.cwd, memoryConfig: options.config.memory });
  const native = await importNativeMemory(options.cwd);
  lines.push(
    `Imported ${project.name}'s history: ${sync.ingested} session(s), ${sync.messages} message(s), ` +
      `${native.autoMemoryItems + native.globalItems} memory item(s) from the agents' own memory. ` +
      "Run `simem sync --all` to import every project.",
  );
  const context: InitContext = { cwd: options.cwd, config: options.config, noModel: options.noModel, statusline: options.statusline, remove: false };
  for (const step of options.extraSteps ?? []) {
    const line = await step(context);
    if (line) lines.push(line);
  }
  lines.push("Restart the Claude Code and Codex apps (or start a new session) so they load the hooks and tools.");
  print(options, lines.join("\n"), { launcher, plans, sync, native });
}
