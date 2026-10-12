#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapters } from "./adapters/index.js";
import { loadConfig, type GatewayConfig } from "./config.js";
import { buildBrief } from "./handoff/brief.js";
import { createCheckpoint } from "./handoff/checkpoints.js";
import {
  HOOK_EVENTS,
  buildMemoryContextBlock,
  captureSession,
  handlePreToolUse,
  handlePreCompact,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit,
  readHookInput,
  recordMemoryInjection,
  taskCompletionSavingsLine,
  type HookEvent,
} from "./handoff/hooks.js";
import { checkIntegration, integrateProvider } from "./handoff/integrate.js";
import { userLevelCovers } from "./install/user-level.js";
import { runDoctor, type ExtraChecks } from "./commands/doctor.js";
import { runInit, type InitContext } from "./commands/init.js";
import { runMigrate, runProject } from "./commands/project.js";
import { runSources, runSync } from "./commands/sources.js";

// Subsystems contribute steps to `mixai init` and checks to `mixai doctor`.
function initSteps(): Array<(context: InitContext) => Promise<string | undefined>> {
  return [];
}

function doctorChecks(): ExtraChecks[] {
  return [];
}
import { discoverSessions } from "./handoff/sessions.js";
import { checkDesktopApp, checkLaunchReadiness } from "./handoff/preflight.js";
import {
  displayCommand,
  launchSwitch,
  prepareSwitch,
  resolveSourceSession,
  type SwitchSurface,
} from "./handoff/switcher.js";
import { handleMemoryCommand } from "./memory/cli-commands.js";
import { consolidateBestEffort } from "./memory/consolidate.js";
import { selectDistillRunner } from "./memory/distill/runner.js";
import { openMemoryDb } from "./memory/db.js";
import { recordGatewayAttempts } from "./memory/ledger.js";
import { runMcpServer } from "./memory/mcp-server.js";
import { GatewayOrchestrator } from "./orchestrator.js";
import { NodeCommandRunner } from "./process.js";
import { PROVIDER_APP_NAME, PROVIDER_IDS, type NormalizedEvent, type ProviderHealth, type ProviderId } from "./types.js";

type Command =
  | "run" | "status" | "sessions" | "export" | "switch" | "fork" | "memory" | "mcp" | "brief" | "hook" | "integrate" | "help" | "version"
  | "init" | "doctor" | "sync" | "sources" | "project" | "migrate" | "recall" | "stats" | "index" | "out" | "dashboard" | "statusline" | "eval";

interface CliOptions {
  command: Command;
  configPath?: string;
  provider?: ProviderId;
  source?: ProviderId;
  target?: ProviderId;
  cwd: string;
  sessionId?: string;
  targetSessionId?: string;
  model?: string;
  note?: string;
  surface: SwitchSurface;
  newSession: boolean;
  write: boolean;
  json: boolean;
  launch: boolean;
  timeoutMs: number;
  prompt: string;
  subcommand?: string;
  positional: string[];
  rebuild: boolean;
  all: boolean;
  embed: boolean;
  includeSuperseded: boolean;
  limit?: number;
  kind?: string;
  groupBy?: string;
  category?: string;
  minImportance?: number;
  since?: string;
  until?: string;
  full: boolean;
  objective?: string;
  maxChars?: number;
  /** True when --cwd was passed explicitly (beats a hook payload's cwd). */
  cwdExplicit: boolean;
  check: boolean;
  remove: boolean;
  /** "user" marks hook/MCP entries written by `mixai init` (vs 1.x per-project ones). */
  scope?: string;
  /** sync --path: ingest one transcript file. */
  path?: string;
  /** migrate --to project|global. */
  to?: string;
  /** dashboard --port. */
  port?: number;
  quiet: boolean;
  /** init/integrate: apply without the interactive cleanup prompt. */
  yes: boolean;
  /** dashboard --open: open the browser. */
  open: boolean;
  /** init --statusline: also install the Claude Code status line. */
  statusline: boolean;
  /** init --no-model: skip the embedding model download. */
  noModel: boolean;
}

function readVersion(): string {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

const HELP = `mixai — coding-agent relay and persistent memory

Cross-agent handoff:
  mixai sessions [codex|claude] [--cwd PATH]
  mixai export [--from codex|claude] [--session ID]
  mixai switch <target> [--from PROVIDER] [--session SOURCE_ID] [--to-session TARGET_ID]
  mixai fork <target> [--from PROVIDER] [--session SOURCE_ID] [--to-session TARGET_ID]
                                   <target>: codex, claude, cursor, or antigravity
                                   (antigravity: --surface desktop cannot select a project folder;
                                    --surface interactive uses the agy CLI and supports --continue)

Agent routing:
  mixai status [--json] [--config PATH]
  mixai run [options] <prompt>

Persistent memory:
  mixai memory search <query> [--kind K] [--category C] [--min-importance N] [--since T] [--until T]
                     [--limit N] [--include-superseded] [--full]
                     Returns compact previews by default (both --json and human output); --full for complete text
  mixai memory show <checkpoint-id|item-id>
  mixai memory stats
  mixai memory spend [--group-by purpose|provider|day]
  mixai memory savings [--json]     Exact, measured token/char savings from mixai's own compression
                                   (compaction, preview disclosure, prompt caps) — not a "vs no mixai" estimate
  mixai memory distill [--all]      Turn checkpoints into memory with local rules (zero provider tokens);
                                   --all also re-mines already-consolidated checkpoints
  mixai memory compact
  mixai memory reindex [--rebuild] [--embed]
  mixai mcp [--cwd PATH] [--provider P]   Serve memory + handoff tools over MCP stdio (requires Node >= 22.5)
                                 --provider identifies the calling agent so list_handoff_targets/
                                 switch_to_provider can exclude it (set automatically by "mixai integrate")

Context revival:
  mixai brief [--objective TEXT] [--max-chars N] [--json]
                                  Print a deterministic revival brief (latest objective/outcome,
                                  live git state, budgeted project memory) — zero LLM calls
  mixai hook <session-start|pre-compact|user-prompt-submit|stop> --provider P [--cwd PATH]
                                  Host-agent lifecycle hook entry (reads the hook JSON from stdin;
                                  wired automatically by "mixai integrate"; always exits 0)
  mixai integrate [--provider P] [--check] [--remove] [--cwd PATH]
                                  Wire a coding agent to call mixai automatically: lifecycle hooks,
                                  MCP registration, and instruction blocks (default: all four);
                                  --check reports drift without writing, --remove undoes it

Handoff options:
  --from PROVIDER                 Source app; default is latest local Codex/Claude session
  --session ID                    Source session (default: latest in this workspace)
  --to-session ID                 Continue a specific target session
  --new                           Start a new target conversation
  --surface desktop|interactive  Desktop is the default on macOS; interactive launches the terminal client
  --no-launch                     Export and print the continuation command without opening an app
  --note TEXT                     Add an operator note to the checkpoint

Memory options:
  --kind semantic|episodic|procedural  Filter memory search/list results
  --category decision|constraint|preference|fact|todo  Filter memory search to one category
  --min-importance N               Only match memory items with importance >= N
  --since TIMESTAMP                Only match records at or after this ISO timestamp
  --until TIMESTAMP                Only match records at or before this ISO timestamp
  --limit N                       Cap the number of search results (default: 10)
  --full                           Return complete text instead of previews (memory search)
  --rebuild                       Drop and recreate the memory index before reindexing
  --embed                         Also (re)compute embeddings via a local Ollama, if configured
  --include-superseded             Also match summaries rolled up by compaction
  --group-by purpose|provider|day  Group "mixai memory spend" output (default: purpose)

Common options:
  --cwd PATH                      Project workspace (default: current directory)
  --json                          Emit machine-readable output
  -h, --help                      Show this help

Run options:
  --provider codex|claude|cursor  Pin one provider; default is policy routing
  --model MODEL                   Override the provider model
  --write                         Allow workspace edits (default is read-only/plan mode)
  --timeout SECONDS               Per-provider timeout (default: 900)
  --config PATH                   JSON configuration file
`;

function provider(value: string, flag: string): ProviderId {
  if (!PROVIDER_IDS.includes(value as ProviderId)) throw new Error(`${flag} has unknown provider: ${value}`);
  return value as ProviderId;
}

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const first = args.shift();
  const known: Command[] = [
    "run", "status", "sessions", "export", "switch", "fork", "memory", "mcp", "brief", "hook", "integrate", "help", "version",
    "init", "doctor", "sync", "sources", "project", "migrate", "recall", "stats", "index", "out", "dashboard", "statusline", "eval",
  ];
  const command: Command = first && known.includes(first as Command)
    ? (first as Command)
    : first === "--help" || first === "-h" || !first
      ? "help"
      : first === "--version" || first === "-v"
        ? "version"
        : "run";
  if (command === "run" && first !== "run") args.unshift(first as string);

  const options: CliOptions = {
    command,
    cwd: process.cwd(),
    surface: process.platform === "darwin" ? "desktop" : "interactive",
    newSession: false,
    write: false,
    json: false,
    launch: true,
    timeoutMs: 900_000,
    prompt: "",
    positional: [],
    rebuild: false,
    all: false,
    embed: false,
    includeSuperseded: false,
    full: false,
    cwdExplicit: false,
    check: false,
    remove: false,
    quiet: false,
    yes: false,
    open: false,
    statusline: false,
    noModel: false,
  };
  const positional: string[] = [];
  for (let index = 0; index < args.length; ) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      args.splice(index, 1);
    } else if (arg === "--write") {
      options.write = true;
      args.splice(index, 1);
    } else if (arg === "--new") {
      options.newSession = true;
      args.splice(index, 1);
    } else if (arg === "--no-launch") {
      options.launch = false;
      args.splice(index, 1);
    } else if (arg === "--rebuild") {
      options.rebuild = true;
      args.splice(index, 1);
    } else if (arg === "--all") {
      options.all = true;
      args.splice(index, 1);
    } else if (arg === "--embed") {
      options.embed = true;
      args.splice(index, 1);
    } else if (arg === "--include-superseded") {
      options.includeSuperseded = true;
      args.splice(index, 1);
    } else if (arg === "--full") {
      options.full = true;
      args.splice(index, 1);
    } else if (arg === "--check") {
      options.check = true;
      args.splice(index, 1);
    } else if (arg === "--remove") {
      options.remove = true;
      args.splice(index, 1);
    } else if (arg === "--quiet") {
      options.quiet = true;
      args.splice(index, 1);
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      args.splice(index, 1);
    } else if (arg === "--open") {
      options.open = true;
      args.splice(index, 1);
    } else if (arg === "--statusline") {
      options.statusline = true;
      args.splice(index, 1);
    } else if (arg === "--no-model") {
      options.noModel = true;
      args.splice(index, 1);
    } else if (arg === "--path") {
      options.path = resolve(takeValue(args, index, arg));
    } else if (arg === "--scope") {
      options.scope = takeValue(args, index, arg);
    } else if (arg === "--to") {
      options.to = takeValue(args, index, arg);
    } else if (arg === "--port") {
      const port = Number(takeValue(args, index, arg));
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be a port number");
      options.port = port;
    } else if (arg === "--limit") {
      const limit = Number(takeValue(args, index, arg));
      if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
      options.limit = limit;
    } else if (arg === "--min-importance") {
      const minImportance = Number(takeValue(args, index, arg));
      if (!Number.isInteger(minImportance) || minImportance < 1 || minImportance > 10) {
        throw new Error("--min-importance must be an integer from 1 to 10");
      }
      options.minImportance = minImportance;
    } else if (arg === "--since") {
      options.since = takeValue(args, index, arg);
    } else if (arg === "--until") {
      options.until = takeValue(args, index, arg);
    } else if (arg === "--kind") {
      options.kind = takeValue(args, index, arg);
    } else if (arg === "--category") {
      options.category = takeValue(args, index, arg);
    } else if (arg === "--group-by") {
      options.groupBy = takeValue(args, index, arg);
    } else if (arg === "--objective") {
      options.objective = takeValue(args, index, arg);
    } else if (arg === "--max-chars") {
      const maxChars = Number(takeValue(args, index, arg));
      if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error("--max-chars must be a positive integer");
      options.maxChars = maxChars;
    } else if (arg === "--config") {
      options.configPath = takeValue(args, index, arg);
    } else if (arg === "--cwd") {
      options.cwd = resolve(takeValue(args, index, arg));
      options.cwdExplicit = true;
    } else if (arg === "--session") {
      options.sessionId = takeValue(args, index, arg);
    } else if (arg === "--to-session") {
      options.targetSessionId = takeValue(args, index, arg);
    } else if (arg === "--model") {
      options.model = takeValue(args, index, arg);
    } else if (arg === "--note") {
      options.note = takeValue(args, index, arg);
    } else if (arg === "--provider") {
      options.provider = provider(takeValue(args, index, arg), arg);
    } else if (arg === "--from") {
      options.source = provider(takeValue(args, index, arg), arg);
    } else if (arg === "--surface") {
      const surface = takeValue(args, index, arg);
      if (surface !== "interactive" && surface !== "desktop") throw new Error(`Unknown surface: ${surface}`);
      options.surface = surface;
    } else if (arg === "--timeout") {
      const seconds = Number(takeValue(args, index, arg));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout must be a positive number");
      options.timeoutMs = seconds * 1_000;
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
      args.splice(index, 1);
    } else if (arg === "--version" || arg === "-v") {
      options.command = "version";
      args.splice(index, 1);
    } else {
      positional.push(arg ?? "");
      args.splice(index, 1);
    }
  }

  if (command === "switch" || command === "fork") {
    const target = positional.shift();
    if (target) options.target = provider(target, command);
  } else if (command === "sessions") {
    const selected = positional.shift();
    if (selected) options.provider = provider(selected, command);
  } else if (command === "memory") {
    const sub = positional.shift();
    if (sub !== undefined) options.subcommand = sub;
  }
  options.positional = [...positional];
  options.prompt = positional.join(" ").trim();
  return options;
}

type StatusItem = ProviderHealth & { desktopInstalled: boolean; desktopVersion?: string };

// "Ready" reflects whether the provider's desktop app is installed, not
// whether its standalone CLI is separately authenticated (or an API key is
// set) — since every provider here is primarily driven through `mixai switch`
// launching the desktop app. "version" is the desktop app's own bundle
// version, not the CLI's; "detail" reports all three readiness dimensions
// (desktop app / CLI / credentials) so a "ready: yes" row that still can't
// run headlessly is self-explanatory. `credential` stays CLI-derived.
async function collectStatusItems(runner: NodeCommandRunner, health: ProviderHealth[]): Promise<StatusItem[]> {
  return await Promise.all(
    health.map(async (item) => {
      const app = await checkDesktopApp(runner, item.provider);
      return { ...item, desktopInstalled: app.installed, ...(app.version ? { desktopVersion: app.version } : {}) };
    }),
  );
}

function describeReadiness(item: StatusItem): string {
  return [
    `desktop app ${item.desktopInstalled ? "ready" : "not installed"}`,
    `CLI ${item.available ? "ready" : "not ready"}`,
    `credentials ${item.authenticated ? "ready" : "not ready"}`,
  ].join(", ");
}

function displayStatus(items: StatusItem[]): void {
  console.table(
    items.map((item) => ({
      provider: item.provider,
      ready: item.desktopInstalled ? "yes" : "no",
      credential: `${item.credential.tier} (${item.credential.source})`,
      version: item.desktopVersion ?? "-",
      detail: describeReadiness(item),
    })),
  );
}

function compactGatewayResult(result: Awaited<ReturnType<GatewayOrchestrator["run"]>>): unknown {
  return {
    type: "gateway.result",
    runId: result.runId,
    ok: result.ok,
    attempts: result.attempts.map((attempt) => ({
      provider: attempt.provider,
      credential: attempt.credential,
      ok: attempt.result.ok,
      failure: attempt.result.failure,
      durationMs: attempt.result.durationMs,
      sessionId: attempt.result.sessionId,
      error: attempt.result.error,
      usage: attempt.result.usage,
    })),
    provider: result.result?.provider,
    sessionId: result.result?.sessionId,
  };
}

async function handleSessions(options: CliOptions): Promise<void> {
  // Cursor/antigravity discovery is cwd-keyed, so all four providers can be
  // listed here — the cwd always accompanies the call.
  const selected = options.provider ? [options.provider] : [...PROVIDER_IDS];
  const sessions = (await Promise.all(selected.map(async (id) => await discoverSessions(id, options.cwd)))).flat();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(sessions)}\n`);
    return;
  }
  console.table(
    sessions.map((session) => ({
      provider: session.provider,
      id: session.id,
      modified: session.modifiedAt,
      origin: session.origin ?? "",
    })),
  );
}

// Best-effort memory distillation after the token-free checkpoint write.
// Failures surface as one stderr line and never affect the command outcome.
async function maybeConsolidate(
  config: GatewayConfig,
  runner: NodeCommandRunner,
  workspace: string,
  checkpointId: string,
): Promise<void> {
  try {
    if (!config.memory.enabled) return;
    const distillRunner = await selectDistillRunner(config.memory, () => new GatewayOrchestrator(config, createAdapters(config, runner)));
    const result = await consolidateBestEffort(workspace, distillRunner, checkpointId, config.memory);
    if (result.status === "done") {
      process.stderr.write(`[mixai] memory: distilled ${result.itemsWritten} new item(s)\n`);
    } else if (result.status === "queued") {
      process.stderr.write(`[mixai] memory: consolidation queued (${result.detail ?? "provider unavailable"})\n`);
    }
  } catch {
    // Memory is additive; switch/export must never fail because of it.
  }
}

// Best-effort: records every attempt from a `mixai run` invocation in the token
// ledger (purpose "run"), so `mixai memory spend` reflects real usage cost,
// not just internal consolidation/rollup calls. Never affects the command's
// own success/failure or output.
async function recordRunLedger(
  config: GatewayConfig,
  cwd: string,
  promptChars: number,
  result: Awaited<ReturnType<GatewayOrchestrator["run"]>>,
): Promise<void> {
  if (!config.memory.enabled) return;
  try {
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return;
    try {
      recordGatewayAttempts(memory, "run", undefined, promptChars, result);
    } finally {
      memory.close();
    }
  } catch {
    // Ledger is additive; `mixai run` must never fail because of it.
  }
}

// When `mixai run` can't finish via any CLI-authenticated agent, a desktop
// app may still work — desktop apps use their own separate login (often a
// different account than the CLI's API key/session), so a CLI-side failure
// doesn't mean the desktop app would fail too. Suggests continuing there
// instead of just reporting failure, with the exact prompt to paste
// (including any injected memory context, so that value isn't lost).
async function suggestDesktopFallback(runner: NodeCommandRunner, prompt: string): Promise<void> {
  const installed = (
    await Promise.all(PROVIDER_IDS.map(async (provider) => ({ provider, status: await checkDesktopApp(runner, provider) })))
  ).filter((entry) => entry.status.installed);
  if (installed.length === 0) return;
  const names = installed.map((entry) => PROVIDER_APP_NAME[entry.provider]).join(", ");
  process.stderr.write(
    `\n[mixai] No CLI-authenticated agent could finish this task. Desktop apps use their own separate login and ` +
      `may work even when the CLI doesn't — installed: ${names}. Open one and paste this prompt to continue:\n\n${prompt}\n`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

// ~1,000 chars/sec — a visible type-ahead reveal without meaningfully
// delaying a response that already took real seconds to generate.
const TYPE_CHARS_PER_TICK = 4;
const TYPE_TICK_MS = 4;

async function typeOut(text: string): Promise<void> {
  for (let index = 0; index < text.length; index += TYPE_CHARS_PER_TICK) {
    process.stdout.write(text.slice(index, index + TYPE_CHARS_PER_TICK));
    await sleep(TYPE_TICK_MS);
  }
}

// Renders a live-streamed `mixai run` response: each assistant.delta chunk
// plays out as a type-ahead reveal, queued strictly in arrival order so a
// slow-to-render chunk can never interleave with the next one that arrives
// while it's still typing. Consecutive chunks get a paragraph break between
// them — providers emit one chunk per completed narration/tool-call segment,
// not per token, so writing them back-to-back with no separator runs
// unrelated sentences together on one line.
function createRunPrinter(): { onDelta: (text: string) => void; settled: () => Promise<void> } {
  let queue: Promise<void> = Promise.resolve();
  let chunkCount = 0;
  return {
    onDelta: (text: string) => {
      chunkCount += 1;
      const prefixed = chunkCount > 1 ? `\n\n${text}` : text;
      queue = queue.then(() => typeOut(prefixed));
    },
    settled: () => queue,
  };
}

// Shows a path relative to the project (or "~/..." for files outside it,
// like antigravity's global GEMINI.md) instead of a full absolute path —
// the raw absolute paths console.table produced were the main reason this
// output was hard to read.
function displayPath(filePath: string, cwd: string): string {
  const rel = relative(cwd, filePath);
  if (!rel.startsWith("..")) return rel;
  const home = homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

const INTEGRATION_ACTION_MARKER: Record<string, string> = {
  created: "+",
  updated: "~",
  removed: "-",
  unchanged: "=",
  failed: "!",
};

// Wires host agents to call mixai automatically: lifecycle hooks + MCP server
// registration + standing instruction blocks, all idempotent file writes.
// --check reports drift without writing (exit 1 on drift, for CI);
// --remove strips exactly what integrate added and nothing else.
async function handleIntegrate(options: CliOptions): Promise<void> {
  const providers = options.provider ? [options.provider] : [...PROVIDER_IDS];
  const plans = [];
  for (const provider of providers) {
    if (options.check) plans.push(await checkIntegration(options.cwd, provider));
    else plans.push(await integrateProvider(options.cwd, provider, { remove: options.remove }));
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(plans)}\n`);
  } else if (options.check) {
    const checks = plans as Awaited<ReturnType<typeof checkIntegration>>[];
    const dirty = checks.filter((check) => !check.upToDate);
    process.stdout.write(
      dirty.length === 0
        ? `All ${checks.length} provider(s) up to date.\n`
        : `${dirty.length}/${checks.length} provider(s) have drift.\n\n`,
    );
    for (const check of checks) {
      process.stdout.write(`${check.provider}: ${check.upToDate ? "up to date" : "drift detected"}\n`);
      for (const line of check.drift) process.stdout.write(`  ${line}\n`);
      for (const note of check.notes) process.stdout.write(`  → ${note}\n`);
    }
  } else {
    const integrations = plans as Awaited<ReturnType<typeof integrateProvider>>[];
    const totalFiles = integrations.reduce((sum, plan) => sum + plan.files.length, 0);
    const changed = integrations.reduce(
      (sum, plan) => sum + plan.files.filter((file) => file.action !== "unchanged").length,
      0,
    );
    const verb = options.remove ? "Removed mixai from" : "Integrated";
    process.stdout.write(
      `${verb} ${integrations.length} provider(s) — ${changed}/${totalFiles} file(s) changed, ${totalFiles - changed} already up to date.\n\n`,
    );
    for (const plan of integrations) {
      process.stdout.write(`${plan.provider}\n`);
      for (const file of plan.files) {
        const marker = INTEGRATION_ACTION_MARKER[file.action] ?? "?";
        const path = displayPath(file.path, options.cwd);
        const suffix = file.note ? ` — ${file.note}` : "";
        process.stdout.write(`  ${marker} ${path} (${file.action})${suffix}\n`);
      }
      for (const note of plan.notes) process.stdout.write(`  → ${note}\n`);
      process.stdout.write("\n");
    }
    process.stdout.write("Run `mixai integrate --check` anytime to verify these are still in place.\n");
  }
  if (options.check && plans.some((plan) => "upToDate" in plan && !plan.upToDate)) process.exitCode = 1;
  const failed = plans.flatMap((plan) => ("files" in plan ? plan.files.filter((file) => file.action === "failed") : []));
  if (failed.length > 0) process.exitCode = 1;
}

// Entry point for host-agent lifecycle hooks (Claude Code / Codex / Cursor).
// Contract: ALWAYS exit 0 and never throw — a failing hook can abort the
// host agent's turn or compaction, which is the single worst outcome mixai
// could cause. Errors go to stderr only.
async function handleHook(options: CliOptions, runner: NodeCommandRunner): Promise<void> {
  try {
    const event = options.positional[0];
    if (!event || !HOOK_EVENTS.includes(event as HookEvent)) {
      throw new Error(`mixai hook requires an event: ${HOOK_EVENTS.join(", ")}`);
    }
    const provider = options.provider;
    if (!provider) throw new Error("mixai hook requires --provider so ledger rows carry a real provider");
    // A 1.x per-project hook stays silent once `mixai init` installed the
    // user-level one for this agent, so the work never runs twice.
    if (options.scope !== "user" && userLevelCovers(provider)) return;
    const config = await loadConfig(options.configPath);
    const input = await readHookInput(process.stdin);
    // The hook payload's cwd (where the host agent runs) beats our own
    // process.cwd() default; an explicit --cwd flag beats both.
    const cwd = options.cwdExplicit ? options.cwd : input.cwd ?? options.cwd;
    if (event === "session-start") {
      process.stdout.write(await handleSessionStart(input, cwd, provider, config, runner));
    } else if (event === "pre-compact") {
      await handlePreCompact(input, cwd, provider, config, runner, undefined, options.configPath);
      await captureSession(input, provider, config, undefined, options.configPath);
    } else if (event === "stop") {
      await captureSession(input, provider, config, undefined, options.configPath);
      process.stdout.write(await handleStop(cwd, config));
    } else if (event === "session-end") {
      await captureSession(input, provider, config, undefined, options.configPath);
    } else if (event === "pre-tool-use") {
      process.stdout.write(await handlePreToolUse(input, cwd, provider, config));
    } else {
      process.stdout.write(await handleUserPromptSubmit(input, cwd, provider, config));
    }
  } catch (error) {
    process.stderr.write(`[mixai] hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

// Deterministic context revival: prints the latest objective/outcome, live
// git state, and budgeted project memory. Zero LLM calls — safe to run on
// every session start or after a context-window compaction.
async function handleBrief(options: CliOptions, runner: NodeCommandRunner): Promise<void> {
  const config = await loadConfig(options.configPath);
  const brief = await buildBrief(runner, {
    cwd: options.cwd,
    memoryConfig: config.memory,
    ...(options.objective !== undefined ? { objective: options.objective } : {}),
    ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
  });
  if (options.json) process.stdout.write(`${JSON.stringify(brief)}\n`);
  else process.stdout.write(brief.text);
}

async function handleExport(options: CliOptions, runner: NodeCommandRunner): Promise<void> {
  const config = await loadConfig(options.configPath);
  const session = await resolveSourceSession(options.cwd, options.source, options.sessionId ?? "latest");
  const checkpoint = await createCheckpoint(runner, session, {
    mode: "export",
    memoryConfig: config.memory,
    ...(options.note ? { note: options.note } : {}),
  });
  if (options.json) process.stdout.write(`${JSON.stringify(checkpoint)}\n`);
  else {
    process.stdout.write(`Checkpoint ${checkpoint.manifest.id}\n`);
    process.stdout.write(`Handoff: ${checkpoint.handoffPath}\n`);
    process.stdout.write(`Transcript: ${checkpoint.transcriptPath}\n`);
    process.stdout.write(`Patch: ${checkpoint.patchPath}\n`);
  }
  await maybeConsolidate(config, runner, checkpoint.manifest.workspace, checkpoint.manifest.id);
}

async function handleSwitch(options: CliOptions, runner: NodeCommandRunner): Promise<void> {
  if (!options.target) throw new Error(`${options.command} requires a target provider`);
  if (options.source === "cursor" || options.source === "antigravity") {
    throw new Error(`${options.source} local transcript export is not implemented yet`);
  }
  const config = await loadConfig(options.configPath);
  const plan = await prepareSwitch(runner, {
    cwd: options.cwd,
    target: options.target,
    ...(options.source ? { source: options.source } : {}),
    ...(options.sessionId ? { sourceSession: options.sessionId } : {}),
    ...(options.targetSessionId ? { targetSession: options.targetSessionId } : {}),
    ...(options.note ? { note: options.note } : {}),
    newSession: options.newSession,
    fork: options.command === "fork",
    surface: options.surface,
    memoryConfig: config.memory,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      checkpoint: plan.checkpoint,
      sourceSession: plan.sourceSession,
      targetSession: plan.targetSession,
      command: plan.command,
      args: plan.args,
      prompt: plan.prompt,
      surface: plan.surface,
      claudeMemory: plan.claudeMemory,
    })}\n`);
  } else {
    const targetAppName = `${PROVIDER_APP_NAME[options.target]} Desktop`;
    process.stdout.write(`Exported ${plan.sourceSession.provider}:${plan.sourceSession.id}\n`);
    process.stdout.write(`Checkpoint: ${plan.checkpoint.handoffPath}\n`);
    process.stdout.write(`${plan.surface === "desktop" ? `Opening ${targetAppName}` : plan.targetSession ? `${options.command === "fork" ? "Forking" : "Resuming"} ${plan.targetSession.provider}:${plan.targetSession.id}` : `Starting a new ${options.target} conversation`}\n`);
    if (plan.surface === "desktop") {
      if (options.target === "claude" && plan.claudeMemory) {
        process.stdout.write(`Claude startup memory: ${plan.claudeMemory.memoryPath}\n`);
        process.stdout.write(`Claude Desktop has no documented Code-tab launch link. Click Code, select ${plan.checkpoint.manifest.workspace}, create a new session, then send \"Continue.\" The checkpoint loads automatically.\n`);
      } else if (options.target === "antigravity") {
        process.stdout.write(`Antigravity Desktop cannot be launched with a project preselected. Open ${plan.checkpoint.manifest.workspace} yourself, then paste this into the agent panel:\n\n${plan.prompt}\n\n`);
      } else {
        process.stdout.write(`${targetAppName}'s launcher cannot receive an initial prompt. In the coding project, open or create the conversation and send:\n\n${plan.prompt}\n\n`);
      }
      if (!options.launch) process.stdout.write(`Open the app with:\n${displayCommand(plan)}\n`);
    } else if (!options.launch) {
      process.stdout.write(`Continue with:\n${displayCommand(plan)}\n`);
    }
  }
  await maybeConsolidate(config, runner, plan.checkpoint.manifest.workspace, plan.checkpoint.manifest.id);
  if (options.launch) {
    const readiness = await checkLaunchReadiness(runner, options.target, plan.surface);
    if (!readiness.ready) {
      process.stderr.write(`[mixai] ${readiness.message ?? `${options.target} is not ready`}\n`);
      if (readiness.loginCommand) process.stderr.write(`[mixai] Run: ${readiness.loginCommand}\n`);
      process.stderr.write(`[mixai] Your checkpoint is safe. After authentication, rerun the same switch command.\n`);
      process.exitCode = 2;
      return;
    }
    const exitCode = await launchSwitch(plan);
    if (exitCode && exitCode !== 0) throw new Error(`${plan.command} exited with code ${exitCode}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (options.command === "version") {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  const runner = new NodeCommandRunner();
  const out = { json: options.json, quiet: options.quiet };
  if (options.command === "init") {
    return await runInit({
      ...out,
      cwd: options.cwd,
      remove: options.remove,
      check: options.check,
      noModel: options.noModel,
      statusline: options.statusline,
      config: await loadConfig(options.configPath),
      extraSteps: initSteps(),
    });
  }
  if (options.command === "doctor") return await runDoctor({ ...out, cwd: options.cwd, extra: doctorChecks() });
  if (options.command === "sync") {
    return await runSync({
      ...out,
      cwd: options.cwd,
      all: options.all,
      config: await loadConfig(options.configPath),
      ...(options.since ? { since: options.since } : {}),
      ...(options.path ? { path: options.path } : {}),
      ...(options.provider && options.provider !== "antigravity" ? { agent: options.provider } : {}),
    });
  }
  if (options.command === "sources") return await runSources(out);
  if (options.command === "project") return await runProject(options.positional[0], options.positional.slice(1), { ...out, cwd: options.cwd });
  if (options.command === "migrate") return await runMigrate(options.to, { ...out, cwd: options.cwd });
  if (options.command === "sessions") return await handleSessions(options);
  if (options.command === "integrate") return await handleIntegrate(options);
  if (options.command === "hook") return await handleHook(options, runner);
  if (options.command === "brief") return await handleBrief(options, runner);
  if (options.command === "export") return await handleExport(options, runner);
  if (options.command === "switch" || options.command === "fork") return await handleSwitch(options, runner);
  if (options.command === "memory") {
    const memoryConfig = await loadConfig(options.configPath);
    return await handleMemoryCommand(options.subcommand, {
      cwd: options.cwd,
      json: options.json,
      args: options.positional,
      rebuild: options.rebuild,
      embed: options.embed,
      includeSuperseded: options.includeSuperseded,
      full: options.full,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.category !== undefined ? { category: options.category } : {}),
      ...(options.minImportance !== undefined ? { minImportance: options.minImportance } : {}),
      ...(options.since !== undefined ? { since: options.since } : {}),
      ...(options.until !== undefined ? { until: options.until } : {}),
      ...(options.groupBy !== undefined ? { groupBy: options.groupBy } : {}),
      all: options.all,
      ...(options.subcommand === "compact" || options.subcommand === "consolidate-checkpoint"
        ? {
            distillRunner: await selectDistillRunner(
              memoryConfig.memory,
              () => new GatewayOrchestrator(memoryConfig, createAdapters(memoryConfig, runner)),
            ),
          }
        : {}),
      memoryConfig: memoryConfig.memory,
    });
  }
  if (options.command === "mcp") {
    const mcpConfig = await loadConfig(options.configPath);
    const superseded = options.scope !== "user" && options.provider !== undefined && userLevelCovers(options.provider);
    return await runMcpServer(options.cwd, undefined, {
      runner,
      memoryConfig: mcpConfig.memory,
      ...(superseded ? { enabledTools: new Set<string>() } : {}),
      ...(options.provider ? { selfProvider: options.provider } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
    });
  }

  const config = await loadConfig(options.configPath);
  const orchestrator = new GatewayOrchestrator(config, createAdapters(config, runner));
  if (options.command === "status") {
    const status = await collectStatusItems(runner, await orchestrator.status());
    if (options.json) process.stdout.write(`${JSON.stringify(status)}\n`);
    else {
      // 2.0: `status` is `doctor` plus which agent apps are ready for a handoff.
      await runDoctor({ ...out, cwd: options.cwd, extra: doctorChecks() });
      process.stdout.write("\nAgents (for handoff):\n");
      displayStatus(status);
    }
    return;
  }
  if (!options.prompt) throw new Error("A prompt is required. Run `mixai --help` for usage.");
  if (!options.json) {
    process.stderr.write(
      "[mixai] `mixai run` is deprecated and will be removed in mixai 3.0; mixai now focuses on memory and saving tokens inside your agent apps.\n",
    );
  }

  // Search project memory for context relevant to this prompt and, if any is
  // found, actually prepend it to what gets sent to the agent — not just a
  // side channel, real context the agent would otherwise lack. The proof
  // line only prints when something real was added, never unconditionally.
  const memoryContextStarted = Date.now();
  const memoryContext = await buildMemoryContextBlock(options.cwd, options.prompt, config);
  const memoryContextDurationMs = Date.now() - memoryContextStarted;
  if (memoryContext.hitCount > 0 && !options.json) {
    process.stderr.write(
      `[mixai] Added ${memoryContext.hitCount} relevant memory item(s) to your prompt — context from earlier work the agent would otherwise have to ask about or miss.\n`,
    );
  }
  const runPrompt = memoryContext.block ? `${memoryContext.block}\n${options.prompt}` : options.prompt;

  // Non-JSON mode also streams the agent's response live instead of staying
  // silent until the whole run finishes: "run.started" announces which
  // provider picked up the task (including mid-run fallbacks), and
  // "assistant.delta" is rendered as a type-ahead reveal with paragraph
  // breaks between chunks (see createRunPrinter). Tool-call events are
  // deliberately not printed — "using <tool>..." for every step added noise
  // without giving the user anything actionable. --json mode keeps its
  // existing behavior of emitting raw NormalizedEvent objects for another
  // program to consume.
  let streamedText = false;
  const printer = createRunPrinter();
  const result = await orchestrator.run(
    {
      prompt: runPrompt,
      cwd: options.cwd,
      accessMode: options.write ? "workspace-write" : "read-only",
      timeoutMs: options.timeoutMs,
      ...(options.model ? { model: options.model } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    },
    {
      ...(options.provider ? { provider: options.provider } : {}),
      onEvent: options.json
        ? (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`)
        : (event: NormalizedEvent) => {
            if (event.type === "run.started") {
              process.stderr.write(`[mixai] → ${event.provider}...\n`);
            } else if (event.type === "assistant.delta" && event.text) {
              streamedText = true;
              printer.onDelta(event.text);
            }
          },
    },
  );
  await printer.settled();
  await recordRunLedger(config, options.cwd, options.prompt.length, result);
  if (memoryContext.hitCount > 0) {
    const injectedInto = result.result?.provider ?? result.attempts.at(-1)?.provider;
    if (injectedInto) {
      await recordMemoryInjection(options.cwd, injectedInto, options.prompt.length, memoryContext.block.length, memoryContextDurationMs);
    }
  }

  if (options.json) process.stdout.write(`${JSON.stringify(compactGatewayResult(result))}\n`);
  else if (result.ok && result.result) {
    // Already streamed live via assistant.delta above; only fall back to a
    // one-shot print if nothing streamed (e.g. a provider that reports no
    // deltas), and otherwise just tidy up the trailing newline.
    if (!streamedText) process.stdout.write(`${result.result.output}\n`);
    else if (!result.result.output.endsWith("\n")) process.stdout.write("\n");
    const credential = result.attempts.at(-1)?.credential;
    process.stderr.write(`\n[mixai] ${result.result.provider} · ${credential?.tier ?? "unknown"} · session ${result.result.sessionId ?? "n/a"}\n`);
    const savingsLine = await taskCompletionSavingsLine(options.cwd, config);
    if (savingsLine) process.stderr.write(`${savingsLine}\n`);
  } else if (result.attempts.length === 0) {
    process.stderr.write("[mixai] No configured provider is both installed and authenticated. Run `mixai status`.\n");
    await suggestDesktopFallback(runner, runPrompt);
    process.exitCode = 2;
  } else {
    for (const attempt of result.attempts) {
      process.stderr.write(`[mixai] ${attempt.provider}: ${attempt.result.failure ?? "failed"}: ${attempt.result.error ?? "unknown error"}\n`);
    }
    await suggestDesktopFallback(runner, runPrompt);
    process.exitCode = 1;
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[mixai] ${message}\n`);
    process.exitCode = 1;
  });
}
