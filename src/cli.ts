#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapters } from "./adapters/index.js";
import { loadConfig } from "./config.js";
import { createCheckpoint } from "./handoff/checkpoints.js";
import { discoverSessions } from "./handoff/sessions.js";
import { checkLaunchReadiness } from "./handoff/preflight.js";
import {
  displayCommand,
  launchSwitch,
  prepareSwitch,
  resolveSourceSession,
  type SwitchSurface,
} from "./handoff/switcher.js";
import { GatewayOrchestrator } from "./orchestrator.js";
import { NodeCommandRunner } from "./process.js";
import { PROVIDER_IDS, type ProviderHealth, type ProviderId } from "./types.js";

type Command = "run" | "status" | "sessions" | "export" | "switch" | "fork" | "help";

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
}

const HELP = `coding-agents-orchestrator (cag)

Cross-agent handoff:
  cag sessions [codex|claude] [--cwd PATH]
  cag export [--from codex|claude] [--session ID]
  cag switch <target> [--from PROVIDER] [--session SOURCE_ID] [--to-session TARGET_ID]
  cag fork <target> [--from PROVIDER] [--session SOURCE_ID] [--to-session TARGET_ID]

Agent routing:
  cag status [--json] [--config PATH]
  cag run [options] <prompt>

Handoff options:
  --from PROVIDER                 Source app; default is latest local Codex/Claude session
  --session ID                    Source session (default: latest in this workspace)
  --to-session ID                 Continue a specific target session
  --new                           Start a new target conversation
  --surface desktop|interactive  Desktop is the default on macOS; interactive launches the terminal client
  --no-launch                     Export and print the continuation command without opening an app
  --note TEXT                     Add an operator note to the checkpoint

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
  const known: Command[] = ["run", "status", "sessions", "export", "switch", "fork", "help"];
  const command: Command = first && known.includes(first as Command)
    ? (first as Command)
    : first === "--help" || first === "-h" || !first
      ? "help"
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
    } else if (arg === "--config") {
      options.configPath = takeValue(args, index, arg);
    } else if (arg === "--cwd") {
      options.cwd = resolve(takeValue(args, index, arg));
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
  }
  options.prompt = positional.join(" ").trim();
  return options;
}

function displayStatus(items: ProviderHealth[]): void {
  console.table(
    items.map((item) => ({
      provider: item.provider,
      ready: item.available && item.authenticated ? "yes" : "no",
      credential: `${item.credential.tier} (${item.credential.source})`,
      version: item.version ?? "-",
      detail: item.detail ?? "",
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
    })),
    provider: result.result?.provider,
    sessionId: result.result?.sessionId,
  };
}

async function handleSessions(options: CliOptions): Promise<void> {
  const selected = options.provider ? [options.provider] : (["codex", "claude"] as ProviderId[]);
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

async function handleExport(options: CliOptions, runner: NodeCommandRunner): Promise<void> {
  const session = await resolveSourceSession(options.cwd, options.source, options.sessionId ?? "latest");
  const checkpoint = await createCheckpoint(runner, session, {
    mode: "export",
    ...(options.note ? { note: options.note } : {}),
  });
  if (options.json) process.stdout.write(`${JSON.stringify(checkpoint)}\n`);
  else {
    process.stdout.write(`Checkpoint ${checkpoint.manifest.id}\n`);
    process.stdout.write(`Handoff: ${checkpoint.handoffPath}\n`);
    process.stdout.write(`Transcript: ${checkpoint.transcriptPath}\n`);
    process.stdout.write(`Patch: ${checkpoint.patchPath}\n`);
  }
}

async function handleSwitch(options: CliOptions, runner: NodeCommandRunner): Promise<void> {
  if (!options.target) throw new Error(`${options.command} requires a target provider`);
  if (options.target === "cursor" && options.source === "cursor") {
    throw new Error("Cursor local transcript export is not implemented yet");
  }
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
    const targetAppName = options.target === "codex" ? "Codex Desktop" : options.target === "claude" ? "Claude Desktop" : "Cursor Desktop";
    process.stdout.write(`Exported ${plan.sourceSession.provider}:${plan.sourceSession.id}\n`);
    process.stdout.write(`Checkpoint: ${plan.checkpoint.handoffPath}\n`);
    process.stdout.write(`${plan.surface === "desktop" ? `Opening ${targetAppName}` : plan.targetSession ? `${options.command === "fork" ? "Forking" : "Resuming"} ${plan.targetSession.provider}:${plan.targetSession.id}` : `Starting a new ${options.target} conversation`}\n`);
    if (plan.surface === "desktop") {
      if (options.target === "claude" && plan.claudeMemory) {
        process.stdout.write(`Claude startup memory: ${plan.claudeMemory.memoryPath}\n`);
        process.stdout.write(`Claude Desktop has no documented Code-tab launch link. Click Code, select ${plan.checkpoint.manifest.workspace}, create a new session, then send \"Continue.\" The checkpoint loads automatically.\n`);
      } else {
        process.stdout.write(`${targetAppName}'s launcher cannot receive an initial prompt. In the coding project, open or create the conversation and send:\n\n${plan.prompt}\n\n`);
      }
      if (!options.launch) process.stdout.write(`Open the app with:\n${displayCommand(plan)}\n`);
    } else if (!options.launch) {
      process.stdout.write(`Continue with:\n${displayCommand(plan)}\n`);
    }
  }
  if (options.launch) {
    const readiness = await checkLaunchReadiness(runner, options.target, plan.surface);
    if (!readiness.ready) {
      process.stderr.write(`[cag] ${readiness.message ?? `${options.target} is not ready`}\n`);
      if (readiness.loginCommand) process.stderr.write(`[cag] Run: ${readiness.loginCommand}\n`);
      process.stderr.write(`[cag] Your checkpoint is safe. After authentication, rerun the same switch command.\n`);
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
  const runner = new NodeCommandRunner();
  if (options.command === "sessions") return await handleSessions(options);
  if (options.command === "export") return await handleExport(options, runner);
  if (options.command === "switch" || options.command === "fork") return await handleSwitch(options, runner);

  const config = await loadConfig(options.configPath);
  const orchestrator = new GatewayOrchestrator(config, createAdapters(config, runner));
  if (options.command === "status") {
    const status = await orchestrator.status();
    if (options.json) process.stdout.write(`${JSON.stringify(status)}\n`);
    else displayStatus(status);
    return;
  }
  if (!options.prompt) throw new Error("A prompt is required. Run `cag --help` for usage.");

  const result = await orchestrator.run(
    {
      prompt: options.prompt,
      cwd: options.cwd,
      accessMode: options.write ? "workspace-write" : "read-only",
      timeoutMs: options.timeoutMs,
      ...(options.model ? { model: options.model } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    },
    {
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.json ? { onEvent: (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`) } : {}),
    },
  );

  if (options.json) process.stdout.write(`${JSON.stringify(compactGatewayResult(result))}\n`);
  else if (result.ok && result.result) {
    process.stdout.write(`${result.result.output}\n`);
    const credential = result.attempts.at(-1)?.credential;
    process.stderr.write(`\n[cag] ${result.result.provider} · ${credential?.tier ?? "unknown"} · session ${result.result.sessionId ?? "n/a"}\n`);
  } else if (result.attempts.length === 0) {
    process.stderr.write("[cag] No configured provider is both installed and authenticated. Run `cag status`.\n");
    process.exitCode = 2;
  } else {
    for (const attempt of result.attempts) {
      process.stderr.write(`[cag] ${attempt.provider}: ${attempt.result.failure ?? "failed"}: ${attempt.result.error ?? "unknown error"}\n`);
    }
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
    process.stderr.write(`[cag] ${message}\n`);
    process.exitCode = 1;
  });
}
