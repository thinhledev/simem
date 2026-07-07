import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProviderId } from "../types.js";
import { ensureClaudeHandoffMemory } from "./claude-memory.js";

// Distinct from claude-memory.ts's cag:handoff markers so the two features
// can update their own blocks in the same file without clobbering each other.
const MD_START = "<!-- cag:integrate:start -->";
const MD_END = "<!-- cag:integrate:end -->";
const TOML_START = "# cag:integrate:start";
const TOML_END = "# cag:integrate:end";

export type IntegrationAction = "created" | "updated" | "unchanged" | "removed" | "failed";

export interface IntegrationFile {
  path: string;
  action: IntegrationAction;
  note?: string;
}

export interface IntegrationPlan {
  provider: ProviderId;
  files: IntegrationFile[];
  notes: string[];
}

export interface IntegrateOptions {
  remove?: boolean;
  /** Compute actions without touching the filesystem (backs `--check`). */
  dryRun?: boolean;
}

const INSTRUCTION_BODY =
  "This project has persistent local memory managed by `cag`. Before re-exploring the repository from " +
  "scratch, check it first: use the `memory_search` MCP tool or `cag memory search \"<topic>\"` for past " +
  "decisions, constraints, and outcomes (results are compact previews — drill in with `memory_get` or " +
  "`cag memory show <id>`). Record new durable decisions the moment they are made with the `memory_save` " +
  "MCP tool. If your context feels thin after a compaction or reset, run `cag brief` (or the " +
  "`context_brief` MCP tool) to reload the latest objective, live workspace state, and the most relevant " +
  "project memory without re-reading the repository.";

function instructionBlock(extra?: string): string {
  return `${MD_START}\n## CAG project memory\n\n${INSTRUCTION_BODY}${extra ? `\n\n${extra}` : ""}\n${MD_END}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseJsonObject(raw: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} exists but is not valid JSON; fix or remove it, then rerun cag integrate`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

// Replace an existing marker-delimited block or append one; returns the next
// file content. Content outside the markers is never touched.
function upsertBlock(original: string | undefined, block: string): string {
  const start = block.startsWith(TOML_START) ? TOML_START : MD_START;
  const end = start === TOML_START ? TOML_END : MD_END;
  const text = original ?? "";
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  if (startIndex >= 0 && endIndex >= startIndex) {
    return `${text.slice(0, startIndex)}${block}${text.slice(endIndex + end.length)}`;
  }
  const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
  return `${prefix}${prefix ? "\n" : ""}${block}\n`;
}

// Strip cag's marker-delimited block; undefined means "delete the file"
// (nothing but our block remained).
function stripBlock(original: string | undefined, tomlMarkers = false): string | undefined {
  if (original === undefined) return undefined;
  const start = tomlMarkers ? TOML_START : MD_START;
  const end = tomlMarkers ? TOML_END : MD_END;
  const startIndex = original.indexOf(start);
  const endIndex = original.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) return original;
  const next = `${original.slice(0, startIndex)}${original.slice(endIndex + end.length)}`.replace(/\n{3,}/g, "\n\n");
  return next.trim() ? next : undefined;
}

// The registration shape Claude Code and Codex share (verified against both
// docs): { hooks: { EventName: [{ hooks: [{ type: "command", command }] }] } }.
// "Stop" fires when the agent finishes responding — the task-completion
// moment where cumulative measured savings get reported.
const HOOK_EVENT_NAMES = ["SessionStart", "PreCompact", "UserPromptSubmit", "Stop"] as const;

const HOOK_EVENT_ARGS: Record<(typeof HOOK_EVENT_NAMES)[number], string> = {
  SessionStart: "session-start",
  PreCompact: "pre-compact",
  UserPromptSubmit: "user-prompt-submit",
  Stop: "stop",
};

function hookCommand(event: (typeof HOOK_EVENT_NAMES)[number], provider: ProviderId): string {
  return `cag hook ${HOOK_EVENT_ARGS[event]} --provider ${provider}`;
}

function groupHasCommand(group: unknown, command: string): boolean {
  return (
    isRecord(group) &&
    Array.isArray(group.hooks) &&
    group.hooks.some((hook) => isRecord(hook) && hook.command === command)
  );
}

function withCagHookEntries(
  settings: Record<string, unknown>,
  provider: ProviderId,
  remove: boolean,
): Record<string, unknown> {
  const clone = structuredClone(settings);
  const hooks = isRecord(clone.hooks) ? clone.hooks : {};
  for (const event of HOOK_EVENT_NAMES) {
    const command = hookCommand(event, provider);
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    if (remove) {
      const kept = groups
        .map((group) => {
          if (!isRecord(group) || !Array.isArray(group.hooks)) return group;
          const remaining = group.hooks.filter((hook) => !(isRecord(hook) && hook.command === command));
          return remaining.length === group.hooks.length ? group : { ...group, hooks: remaining };
        })
        .filter((group) => !isRecord(group) || !Array.isArray(group.hooks) || group.hooks.length > 0);
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    } else if (!groups.some((group) => groupHasCommand(group, command))) {
      hooks[event] = [...groups, { hooks: [{ type: "command", command }] }];
    }
  }
  if (Object.keys(hooks).length > 0) clone.hooks = hooks;
  else delete clone.hooks;
  return clone;
}

function withCagMcpServer(config: Record<string, unknown>, cwd: string, remove: boolean): Record<string, unknown> {
  const clone = structuredClone(config);
  const servers = isRecord(clone.mcpServers) ? clone.mcpServers : {};
  if (remove) delete servers["cag-memory"];
  else servers["cag-memory"] = { command: "cag", args: ["mcp", "--cwd", cwd] };
  if (Object.keys(servers).length > 0) clone.mcpServers = servers;
  else delete clone.mcpServers;
  return clone;
}

function stableJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Applies one file's next content (undefined = delete), recording what
// happened. A parse failure on the existing file aborts THAT file only —
// never overwrite something we could not understand.
async function applyFile(
  plan: IntegrationPlan,
  path: string,
  compute: (original: string | undefined) => string | undefined,
  options: IntegrateOptions,
  note?: string,
): Promise<void> {
  let original: string | undefined;
  let next: string | undefined;
  try {
    original = await readOptional(path);
    next = compute(original);
  } catch (error) {
    plan.files.push({ path, action: "failed", note: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (next === original) {
    plan.files.push({ path, action: "unchanged", ...(note ? { note } : {}) });
    return;
  }
  const action: IntegrationAction = original === undefined ? "created" : next === undefined ? "removed" : "updated";
  if (!options.dryRun) {
    if (next === undefined) {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, next, "utf8");
    }
  }
  plan.files.push({ path, action, ...(note ? { note } : {}) });
}

function jsonTransform(
  path: string,
  transform: (existing: Record<string, unknown>) => Record<string, unknown>,
): (original: string | undefined) => string | undefined {
  return (original) => {
    const existing = original === undefined ? {} : parseJsonObject(original, path);
    const next = transform(existing);
    if (Object.keys(next).length === 0 && original === undefined) return undefined;
    if (Object.keys(next).length === 0) return undefined;
    const serialized = stableJson(next);
    return original !== undefined && stableJson(parseJsonObject(original, path)) === serialized ? original : serialized;
  };
}

const CURSOR_HOOKS_NOTE = "Cursor hook registration schema is unverified — confirm against your Cursor version";

async function integrateClaude(cwd: string, options: IntegrateOptions): Promise<IntegrationPlan> {
  const plan: IntegrationPlan = { provider: "claude", files: [], notes: [] };
  const remove = Boolean(options.remove);
  const settingsPath = join(cwd, ".claude", "settings.json");
  await applyFile(plan, settingsPath, jsonTransform(settingsPath, (existing) => withCagHookEntries(existing, "claude", remove)), options);
  const mcpPath = join(cwd, ".mcp.json");
  await applyFile(plan, mcpPath, jsonTransform(mcpPath, (existing) => withCagMcpServer(existing, cwd, remove)), options);
  const memoryPath = join(cwd, "CLAUDE.local.md");
  await applyFile(
    plan,
    memoryPath,
    (original) => (remove ? stripBlock(original) : upsertBlock(original, instructionBlock())),
    options,
  );
  if (!remove && !options.dryRun) {
    // The session-start hook suppresses plain-resume output because this
    // import block feeds HANDOFF.md at startup; keep them installed together.
    await ensureClaudeHandoffMemory(cwd);
  }
  if (!remove) {
    const memoryContent = await readOptional(memoryPath);
    if (options.dryRun && !(memoryContent ?? "").includes("cag:handoff:start")) {
      plan.notes.push(
        "CLAUDE.local.md lacks the cag:handoff import block; run `cag integrate --provider claude` (without --check) to install both together",
      );
    }
  }
  return plan;
}

async function integrateCodex(cwd: string, options: IntegrateOptions): Promise<IntegrationPlan> {
  const plan: IntegrationPlan = { provider: "codex", files: [], notes: [] };
  const remove = Boolean(options.remove);
  const hooksPath = join(cwd, ".codex", "hooks.json");
  await applyFile(plan, hooksPath, jsonTransform(hooksPath, (existing) => withCagHookEntries(existing, "codex", remove)), options);
  const configPath = join(cwd, ".codex", "config.toml");
  const tomlBlock = `${TOML_START}\n[mcp_servers.cag-memory]\ncommand = "cag"\nargs = ["mcp", "--cwd", "${cwd}"]\n${TOML_END}`;
  await applyFile(
    plan,
    configPath,
    (original) => (remove ? stripBlock(original, true) : upsertBlock(original, tomlBlock)),
    options,
  );
  const agentsPath = join(cwd, "AGENTS.md");
  await applyFile(
    plan,
    agentsPath,
    (original) => (remove ? stripBlock(original) : upsertBlock(original, instructionBlock())),
    options,
  );
  if (!remove) {
    plan.notes.push("Codex loads project .codex/ hooks only when the project is trusted (approve the trust prompt or `codex trust`)");
  }
  return plan;
}

async function integrateCursor(cwd: string, options: IntegrateOptions): Promise<IntegrationPlan> {
  const plan: IntegrationPlan = { provider: "cursor", files: [], notes: [] };
  const remove = Boolean(options.remove);
  const mcpPath = join(cwd, ".cursor", "mcp.json");
  await applyFile(plan, mcpPath, jsonTransform(mcpPath, (existing) => withCagMcpServer(existing, cwd, remove)), options);
  // Best-guess registration mirroring Cursor's documented event vocabulary
  // (sessionStart / beforeSubmitPrompt / stop); Cursor has no compaction hook.
  const hooksPath = join(cwd, ".cursor", "hooks.json");
  await applyFile(
    plan,
    hooksPath,
    jsonTransform(hooksPath, (existing) => {
      const clone = structuredClone(existing);
      const hooks = isRecord(clone.hooks) ? clone.hooks : {};
      const entries: Array<[string, string]> = [
        ["sessionStart", "cag hook session-start --provider cursor"],
        ["beforeSubmitPrompt", "cag hook user-prompt-submit --provider cursor"],
        ["stop", "cag hook stop --provider cursor"],
      ];
      for (const [event, command] of entries) {
        const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
        if (remove) {
          const kept = groups.filter((group) => !(isRecord(group) && group.command === command));
          if (kept.length > 0) hooks[event] = kept;
          else delete hooks[event];
        } else if (!groups.some((group) => isRecord(group) && group.command === command)) {
          hooks[event] = [...groups, { command }];
        }
      }
      if (Object.keys(hooks).length > 0) {
        clone.version = clone.version ?? 1;
        clone.hooks = hooks;
      } else {
        delete clone.hooks;
        if (Object.keys(clone).length === 1 && clone.version !== undefined) delete clone.version;
      }
      return clone;
    }),
    options,
    CURSOR_HOOKS_NOTE,
  );
  const rulesPath = join(cwd, ".cursor", "rules", "cag-memory.mdc");
  const rulesContent = `---\ndescription: CAG persistent project memory\nalwaysApply: true\n---\n\n${instructionBlock()}\n`;
  await applyFile(plan, rulesPath, (original) => (remove ? undefined : original === rulesContent ? original : rulesContent), options);
  if (!remove) plan.notes.push(CURSOR_HOOKS_NOTE);
  return plan;
}

function geminiConfigDir(): string {
  return process.env.GEMINI_CONFIG_DIR ?? join(homedir(), ".gemini");
}

async function integrateAntigravity(cwd: string, options: IntegrateOptions): Promise<IntegrationPlan> {
  const plan: IntegrationPlan = { provider: "antigravity", files: [], notes: [] };
  const remove = Boolean(options.remove);
  // Global GEMINI.md is the only verified instructions surface for agy;
  // there are no lifecycle hooks and no confirmed MCP registration.
  const geminiPath = join(geminiConfigDir(), "GEMINI.md");
  const block = instructionBlock(
    "Automatic lifecycle hooks are not available for this agent — run `cag brief` yourself when resuming " +
      "work or after losing context, and `cag memory search` before re-exploring a repository.",
  );
  await applyFile(plan, geminiPath, (original) => (remove ? stripBlock(original) : upsertBlock(original, block)), options);
  if (!remove) {
    plan.notes.push("Antigravity (agy) has no lifecycle hooks; instructions are global (~/.gemini/GEMINI.md), not per-project");
    plan.notes.push("MCP registration for agy is unverified — memory tools remain reachable via the `cag memory` CLI");
  }
  return plan;
}

export async function integrateProvider(
  cwd: string,
  provider: ProviderId,
  options: IntegrateOptions = {},
): Promise<IntegrationPlan> {
  const root = resolve(cwd);
  if (provider === "claude") return await integrateClaude(root, options);
  if (provider === "codex") return await integrateCodex(root, options);
  if (provider === "cursor") return await integrateCursor(root, options);
  return await integrateAntigravity(root, options);
}

export interface IntegrationCheck {
  provider: ProviderId;
  upToDate: boolean;
  drift: string[];
  notes: string[];
}

export async function checkIntegration(cwd: string, provider: ProviderId): Promise<IntegrationCheck> {
  const plan = await integrateProvider(cwd, provider, { dryRun: true });
  const drift = plan.files
    .filter((file) => file.action !== "unchanged")
    .map((file) => `${file.path}: would be ${file.action}${file.note ? ` (${file.note})` : ""}`);
  return { provider, upToDate: drift.length === 0, drift, notes: plan.notes };
}
