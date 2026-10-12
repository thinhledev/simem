import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  applyFile,
  instructionBlock,
  isRecord,
  jsonTransform,
  stripBlock,
  TOML_END,
  TOML_START,
  upsertBlock,
  type IntegrateOptions,
  type IntegrationPlan,
} from "../handoff/integrate.js";
import { discoverHomes, type AgentHome } from "../sources/homes.js";
import { ensurePrivateDir, simemHome } from "../store/home.js";
import type { ProviderId } from "../types.js";
import { launcherPath } from "./launcher.js";

// User-level install: one set of hooks, one MCP server, and one instruction
// block per agent account home, covering every project and worktree on the
// machine. Entries are byte-stable (a fixed dispatcher command per event), so
// the Codex app's per-hook trust hashes stay valid across simem upgrades —
// behaviour changes come from simem's config, never from rewriting hooks.

export const MCP_SERVER_NAME = "simem";

type HookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PreCompact" | "Stop" | "SessionEnd";

const HOOK_ARG: Record<HookEventName, string> = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PreToolUse: "pre-tool-use",
  PreCompact: "pre-compact",
  Stop: "stop",
  SessionEnd: "session-end",
};

const STATUS: Record<HookEventName, string> = {
  SessionStart: "simem: project primer",
  UserPromptSubmit: "simem: relevant project memory",
  PreToolUse: "simem: output compression and read guards",
  PreCompact: "simem: save context before compaction",
  Stop: "simem: capture this turn into memory",
  SessionEnd: "simem: capture the session into memory",
};

// Codex can only rewrite a tool call by also auto-approving it, and has no
// Read tool to guard, so it gets no PreToolUse entry.
const EVENTS: Record<"claude" | "codex", HookEventName[]> = {
  claude: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PreCompact", "Stop", "SessionEnd"],
  codex: ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop", "SessionEnd"],
};

export function hookCommand(event: HookEventName, provider: ProviderId, launcher = launcherPath()): string {
  return `"${launcher}" hook ${HOOK_ARG[event]} --provider ${provider} --scope user`;
}

function isOurHook(hook: unknown): boolean {
  return isRecord(hook) && typeof hook.command === "string" && hook.command.includes("--scope user") && /\bhook [a-z-]+ --provider\b/.test(hook.command);
}

export function withUserHooks(settings: Record<string, unknown>, provider: "claude" | "codex", remove: boolean, launcher = launcherPath()): Record<string, unknown> {
  const clone = structuredClone(settings);
  const hooks = isRecord(clone.hooks) ? clone.hooks : {};
  for (const event of Object.keys(HOOK_ARG) as HookEventName[]) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    // Drop any previous simem user-scope entry for this event, then add the
    // current one: converges stale entries (e.g. an old launcher path).
    const kept = groups
      .map((group) => {
        if (!isRecord(group) || !Array.isArray(group.hooks)) return group;
        const remaining = group.hooks.filter((hook) => !isOurHook(hook));
        return remaining.length === group.hooks.length ? group : { ...group, hooks: remaining };
      })
      .filter((group) => !isRecord(group) || !Array.isArray(group.hooks) || group.hooks.length > 0);
    if (!remove && EVENTS[provider].includes(event)) {
      const entry: Record<string, unknown> = {
        hooks: [{ type: "command", command: hookCommand(event, provider, launcher), statusMessage: STATUS[event], timeout: event === "PreToolUse" ? 10 : 30 }],
      };
      if (event === "PreToolUse") entry.matcher = "Bash|Read";
      kept.push(entry);
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) clone.hooks = hooks;
  else delete clone.hooks;
  return clone;
}

function withUserMcp(config: Record<string, unknown>, provider: ProviderId, remove: boolean, launcher = launcherPath()): Record<string, unknown> {
  const clone = structuredClone(config);
  const servers = isRecord(clone.mcpServers) ? clone.mcpServers : {};
  if (remove) delete servers[MCP_SERVER_NAME];
  else servers[MCP_SERVER_NAME] = { type: "stdio", command: launcher, args: ["mcp", "--provider", provider, "--scope", "user"], env: {} };
  if (Object.keys(servers).length > 0) clone.mcpServers = servers;
  else delete clone.mcpServers;
  return clone;
}

// User-scope MCP servers live in the account's .claude.json: ~/.claude.json
// for the default ~/.claude home, <dir>/.claude.json for CLAUDE_CONFIG_DIR homes.
export function claudeUserConfigPath(home: AgentHome): string {
  return home.dir === join(homedir(), ".claude") ? join(homedir(), ".claude.json") : join(home.dir, ".claude.json");
}

async function installClaudeHome(home: AgentHome, options: IntegrateOptions, launcher: string): Promise<IntegrationPlan> {
  const plan: IntegrationPlan = { provider: "claude", files: [], notes: [] };
  const remove = Boolean(options.remove);
  const settings = join(home.dir, "settings.json");
  await applyFile(plan, settings, jsonTransform(settings, (existing) => withUserHooks(existing, "claude", remove, launcher)), options);
  const userConfig = claudeUserConfigPath(home);
  // Never create ~/.claude.json for an account that has not run yet; the app owns it.
  if (existsSync(userConfig)) {
    await applyFile(plan, userConfig, jsonTransform(userConfig, (existing) => withUserMcp(existing, "claude", remove, launcher)), options);
  } else if (!remove) {
    plan.notes.push(`${home.label}: no ${basename(userConfig)} yet (open Claude Code once with this account, then re-run simem init) — MCP tools not registered`);
  }
  const memory = join(home.dir, "CLAUDE.md");
  await applyFile(plan, memory, (original) => (remove ? stripBlock(original) : upsertBlock(original, instructionBlock())), options);
  return plan;
}

async function installCodexHome(home: AgentHome, options: IntegrateOptions, launcher: string): Promise<IntegrationPlan> {
  const plan: IntegrationPlan = { provider: "codex", files: [], notes: [] };
  const remove = Boolean(options.remove);
  const hooks = join(home.dir, "hooks.json");
  await applyFile(plan, hooks, jsonTransform(hooks, (existing) => withUserHooks(existing, "codex", remove, launcher)), options);
  const config = join(home.dir, "config.toml");
  const block = `${TOML_START}\n[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "${launcher}"\nargs = ["mcp", "--provider", "codex", "--scope", "user"]\n${TOML_END}`;
  await applyFile(plan, config, (original) => (remove ? stripBlock(original, true) : upsertBlock(original, block)), options);
  const agents = join(home.dir, "AGENTS.md");
  await applyFile(plan, agents, (original) => (remove ? stripBlock(original) : upsertBlock(original, instructionBlock())), options);
  if (!remove) plan.notes.push(`${home.label}: Codex asks you to trust new hooks once (Codex app or \`/hooks\` in the CLI); entries never change after that`);
  return plan;
}

async function installCursorHome(home: AgentHome, options: IntegrateOptions, launcher: string): Promise<IntegrationPlan> {
  const plan: IntegrationPlan = { provider: "cursor", files: [], notes: [] };
  const mcp = join(home.dir, "mcp.json");
  await applyFile(plan, mcp, jsonTransform(mcp, (existing) => withUserMcp(existing, "cursor", Boolean(options.remove), launcher)), options);
  if (!options.remove) plan.notes.push(`${home.label}: Cursor gets the MCP tools; for hooks run \`simem integrate --provider cursor\` in a project`);
  return plan;
}

export interface InstallRecord {
  version: 1;
  installedAt: string;
  launcher: string;
  providers: ProviderId[];
  homes: string[];
}

export function installRecordPath(): string {
  return join(simemHome(), "installed.json");
}

export function readInstallRecord(): InstallRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(installRecordPath(), "utf8")) as InstallRecord;
    return record.version === 1 ? record : undefined;
  } catch {
    return undefined;
  }
}

export async function installUserLevel(options: IntegrateOptions = {}, launcher = launcherPath()): Promise<IntegrationPlan[]> {
  const plans: IntegrationPlan[] = [];
  const homes = discoverHomes();
  for (const home of homes) {
    if (home.agent === "claude") plans.push(await installClaudeHome(home, options, launcher));
    else if (home.agent === "codex") plans.push(await installCodexHome(home, options, launcher));
    else plans.push(await installCursorHome(home, options, launcher));
  }
  if (!options.dryRun) {
    ensurePrivateDir(dirname(installRecordPath()));
    if (options.remove) {
      writeFileSync(installRecordPath(), `${JSON.stringify({ version: 1, installedAt: "", launcher, providers: [], homes: [] }, null, 2)}\n`);
    } else {
      const record: InstallRecord = {
        version: 1,
        installedAt: new Date().toISOString(),
        launcher,
        providers: [...new Set(plans.map((plan) => plan.provider))],
        homes: homes.map((home) => home.dir),
      };
      writeFileSync(installRecordPath(), `${JSON.stringify(record, null, 2)}\n`);
    }
  }
  return plans;
}

// True when user-level hooks/MCP cover this provider, in which case a 1.x
// per-project hook or MCP entry (no `--scope user`) stays silent so nothing
// runs twice.
export function userLevelCovers(provider: ProviderId): boolean {
  return Boolean(readInstallRecord()?.providers.includes(provider));
}
