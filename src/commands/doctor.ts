import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readLauncher } from "../install/launcher.js";
import { claudeUserConfigPath, hookCommand, MCP_SERVER_NAME, readInstallRecord } from "../install/user-level.js";
import { openMemoryDb } from "../memory/db.js";
import { discoverHomes } from "../sources/homes.js";
import { resolveProject } from "../store/project.js";
import { displayPath, print, type Output } from "./common.js";

export type CheckLevel = "ok" | "warn" | "fail" | "info";

export interface Check {
  level: CheckLevel;
  area: string;
  message: string;
}

export type ExtraChecks = (cwd: string) => Promise<Check[]>;

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function contains(path: string, needle: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(needle);
  } catch {
    return false;
  }
}

export async function collectChecks(cwd: string, extra: ExtraChecks[] = []): Promise<Check[]> {
  const checks: Check[] = [];
  const launcher = readLauncher();
  const record = readInstallRecord();
  if (!launcher.exists) {
    checks.push({ level: "fail", area: "install", message: "Not installed for the desktop apps yet. Run `mixai init` once." });
  } else if (!launcher.nodeOk || !launcher.cliOk) {
    checks.push({ level: "fail", area: "install", message: `Launcher points at a missing ${!launcher.nodeOk ? "Node.js" : "mixai"} (${launcher.node ?? "?"}). Re-run \`mixai init\`.` });
  } else {
    checks.push({ level: "ok", area: "install", message: `Launcher ${displayPath(launcher.path)} → Node ${launcher.node ? displayPath(launcher.node) : "?"}` });
  }

  for (const home of discoverHomes()) {
    if (home.agent === "claude") {
      const settings = readJson(join(home.dir, "settings.json"));
      const hooksOk = JSON.stringify(settings?.hooks ?? {}).includes(JSON.stringify(hookCommand("UserPromptSubmit", "claude", launcher.path)).slice(1, -1));
      const userConfig = readJson(claudeUserConfigPath(home));
      const mcpOk = Boolean((userConfig?.mcpServers as Record<string, unknown> | undefined)?.[MCP_SERVER_NAME]);
      checks.push({
        level: hooksOk && mcpOk ? "ok" : record ? "warn" : "info",
        area: home.label,
        message: `hooks ${hooksOk ? "installed" : "missing"}, MCP tools ${mcpOk ? "registered" : "missing"}${hooksOk && mcpOk ? "" : " — run `mixai init`"}`,
      });
    } else if (home.agent === "codex") {
      const hooksOk = contains(join(home.dir, "hooks.json"), "--scope user");
      const mcpOk = contains(join(home.dir, "config.toml"), `[mcp_servers.${MCP_SERVER_NAME}]`);
      checks.push({
        level: hooksOk && mcpOk ? "ok" : record ? "warn" : "info",
        area: home.label,
        message: `hooks ${hooksOk ? "installed (trust them once in Codex)" : "missing"}, MCP tools ${mcpOk ? "registered" : "missing"}`,
      });
    } else {
      const mcpOk = contains(join(home.dir, "mcp.json"), `"${MCP_SERVER_NAME}"`);
      checks.push({ level: mcpOk ? "ok" : "info", area: home.label, message: `MCP tools ${mcpOk ? "registered" : "not registered"}` });
    }
  }

  const project = resolveProject(cwd);
  checks.push({ level: "info", area: "project", message: `${project.name} (${project.id}) → ${displayPath(project.storeDir)} [${project.mode}, by ${project.identifiedBy}]` });
  const legacyDb = join(project.root, ".mixai", "memory.db");
  if (project.mode === "global" && existsSync(legacyDb) && existsSync(join(project.storeDir, "memory.db"))) {
    checks.push({ level: "warn", area: "project", message: `An unmerged 1.x database remains at ${displayPath(legacyDb, cwd)}; merge it with mixai memory export/import.` });
  }
  const memory = await openMemoryDb(cwd, { quiet: true });
  if (!memory) {
    checks.push({ level: "fail", area: "memory", message: `Memory unavailable (needs Node.js >= 22.5; this is ${process.version}).` });
  } else {
    try {
      const count = (sql: string) => (memory.db.prepare(sql).get() as { n: number }).n;
      const sessions = count("SELECT COUNT(*) AS n FROM sessions");
      const items = count("SELECT COUNT(*) AS n FROM memory_items WHERE status = 'active'");
      const latest = memory.db.prepare("SELECT MAX(last_activity_at) AS at FROM sessions").get() as { at: string | null };
      const size = existsSync(memory.path) ? statSync(memory.path).size : 0;
      checks.push({
        level: sessions > 0 ? "ok" : "warn",
        area: "memory",
        message: `${sessions} session(s), ${items} active item(s), ${(size / 1_048_576).toFixed(1)} MB` +
          (latest.at ? `, last capture ${latest.at.slice(0, 16).replace("T", " ")}` : " — nothing captured yet; run `mixai sync`"),
      });
    } finally {
      memory.close();
    }
  }
  for (const add of extra) checks.push(...(await add(cwd)));
  return checks;
}

const ICON: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };

export async function runDoctor(options: Output & { cwd: string; extra?: ExtraChecks[] }): Promise<void> {
  const checks = await collectChecks(options.cwd, options.extra ?? []);
  if (options.json) {
    print(options, "", checks);
  } else {
    print(options, checks.map((check) => `${ICON[check.level]} ${check.area.padEnd(24)} ${check.message}`).join("\n"));
  }
  if (checks.some((check) => check.level === "fail")) process.exitCode = 1;
}
