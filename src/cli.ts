#!/usr/bin/env node
import { resolve } from "node:path";
import { createAdapters } from "./adapters/index.js";
import { loadConfig } from "./config.js";
import { GatewayOrchestrator } from "./orchestrator.js";
import { NodeCommandRunner } from "./process.js";
import { PROVIDER_IDS, type ProviderHealth, type ProviderId } from "./types.js";

interface CliOptions {
  command: "run" | "status" | "help";
  configPath?: string;
  provider?: ProviderId;
  cwd: string;
  sessionId?: string;
  model?: string;
  write: boolean;
  json: boolean;
  timeoutMs: number;
  prompt: string;
}

const HELP = `coding-agents-orchestrator (cag)

Usage:
  cag status [--json] [--config PATH]
  cag run [options] <prompt>

Options:
  --provider codex|claude|cursor  Pin one provider; default is policy routing
  --cwd PATH                      Workspace for the agent (default: current directory)
  --session ID                    Resume a provider-native session
  --model MODEL                   Override the provider model
  --write                         Allow workspace edits (default is read-only/plan mode)
  --timeout SECONDS               Per-provider timeout (default: 900)
  --config PATH                   JSON configuration file
  --json                          Emit normalized JSONL events
  -h, --help                      Show this help
`;

function takeValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const first = args.shift();
  const command = first === "status" ? "status" : first === "run" ? "run" : first === "help" || first === "--help" || first === "-h" || !first ? "help" : "run";
  if (command === "run" && first !== "run") args.unshift(first as string);

  const options: CliOptions = {
    command,
    cwd: process.cwd(),
    write: false,
    json: false,
    timeoutMs: 900_000,
    prompt: "",
  };
  const promptParts: string[] = [];
  for (let index = 0; index < args.length; ) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      args.splice(index, 1);
    } else if (arg === "--write") {
      options.write = true;
      args.splice(index, 1);
    } else if (arg === "--config") {
      options.configPath = takeValue(args, index, arg);
    } else if (arg === "--cwd") {
      options.cwd = resolve(takeValue(args, index, arg));
    } else if (arg === "--session") {
      options.sessionId = takeValue(args, index, arg);
    } else if (arg === "--model") {
      options.model = takeValue(args, index, arg);
    } else if (arg === "--provider") {
      const provider = takeValue(args, index, arg);
      if (!PROVIDER_IDS.includes(provider as ProviderId)) throw new Error(`Unknown provider: ${provider}`);
      options.provider = provider as ProviderId;
    } else if (arg === "--timeout") {
      const seconds = Number(takeValue(args, index, arg));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout must be a positive number");
      options.timeoutMs = seconds * 1_000;
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
      args.splice(index, 1);
    } else {
      promptParts.push(arg ?? "");
      args.splice(index, 1);
    }
  }
  options.prompt = promptParts.join(" ").trim();
  return options;
}

function displayStatus(items: ProviderHealth[]): void {
  const rows = items.map((item) => ({
    provider: item.provider,
    ready: item.available && item.authenticated ? "yes" : "no",
    credential: `${item.credential.tier} (${item.credential.source})`,
    version: item.version ?? "-",
    detail: item.detail ?? "",
  }));
  console.table(rows);
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    process.stdout.write(HELP);
    return;
  }
  const config = await loadConfig(options.configPath);
  const orchestrator = new GatewayOrchestrator(config, createAdapters(config, new NodeCommandRunner()));
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[cag] ${message}\n`);
  process.exitCode = 1;
});
