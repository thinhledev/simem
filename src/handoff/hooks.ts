import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayConfig } from "../config.js";
import { openMemoryDb } from "../memory/db.js";
import { recordLlmCall } from "../memory/ledger.js";
import { toPreview } from "../memory/preview.js";
import { search } from "../memory/retrieval.js";
import { capText } from "../memory/text-cap.js";
import type { CommandRunner } from "../process.js";
import type { ProviderId } from "../types.js";
import { buildBrief } from "./brief.js";
import { createCheckpoint } from "./checkpoints.js";
import { resolveSession } from "./sessions.js";
import type { SessionInfo } from "./types.js";

export type HookEvent = "session-start" | "pre-compact" | "user-prompt-submit";

export const HOOK_EVENTS: HookEvent[] = ["session-start", "pre-compact", "user-prompt-submit"];

// Loose superset of what host agents put on a hook's stdin. Claude Code and
// Codex share the snake_case field names; anything else (Cursor's schema is
// unverified) is parsed best-effort — missing fields degrade to "resolve the
// latest session for this cwd", never to an error.
export interface RawHookInput {
  source?: string;
  sessionId?: string;
  transcriptPath?: string;
  prompt?: string;
  cwd?: string;
}

// Hook payloads are tiny; anything bigger than this is not a hook payload.
const MAX_HOOK_INPUT_CHARS = 1_000_000;

// A host agent that never closes our stdin must not hang its own lifecycle
// event; after this long we proceed with whatever arrived (usually nothing).
const HOOK_INPUT_TIMEOUT_MS = 2_000;

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function parseHookInput(raw: string): RawHookInput {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const source = firstString(record, ["source", "trigger"]);
    const sessionId = firstString(record, ["session_id", "sessionId", "conversation_id", "conversationId"]);
    const transcriptPath = firstString(record, ["transcript_path", "transcriptPath"]);
    const prompt = firstString(record, ["prompt", "user_prompt", "userPrompt", "text"]);
    const cwd = firstString(record, ["cwd", "workspace", "project_dir", "projectDir"]);
    return {
      ...(source !== undefined ? { source } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(transcriptPath !== undefined ? { transcriptPath } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    };
  } catch {
    return {};
  }
}

export async function readHookInput(stdin: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<RawHookInput> {
  if (stdin.isTTY) return {};
  const read = new Promise<string>((resolvePromise) => {
    let data = "";
    stdin.setEncoding?.("utf8");
    stdin.on("data", (chunk: string) => {
      if (data.length < MAX_HOOK_INPUT_CHARS) data += chunk;
    });
    stdin.on("end", () => resolvePromise(data));
    stdin.on("error", () => resolvePromise(data));
  });
  const timeout = new Promise<string>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(""), HOOK_INPUT_TIMEOUT_MS);
    timer.unref?.();
  });
  const raw = await Promise.race([read, timeout]);
  return raw.trim() ? parseHookInput(raw) : {};
}

// Session-start sources that mean "the context window was just lost".
const REVIVAL_SOURCES = new Set(["compact", "resume", "clear"]);

// Emits the revival brief for context-loss session starts. For Claude Code,
// plain resume is suppressed: cag's CLAUDE.local.md block already @imports
// .cag/current/HANDOFF.md on every session start, so injecting the brief
// there too would double-feed the same context. "compact"/"clear" still get
// the brief — its live git state and memory section aren't in the import.
export async function handleSessionStart(
  input: RawHookInput,
  cwd: string,
  provider: ProviderId,
  config: GatewayConfig,
  runner: CommandRunner,
): Promise<string> {
  if (!config.memory.hooks.sessionStartBrief) return "";
  const source = input.source ?? "";
  if (!REVIVAL_SOURCES.has(source)) return "";
  if (provider === "claude" && source === "resume") return "";
  const brief = await buildBrief(runner, {
    cwd,
    memoryConfig: config.memory,
    maxChars: config.memory.hooks.briefMaxChars,
  });
  return brief.text;
}

async function sessionFromTranscriptPath(
  provider: ProviderId,
  transcriptPath: string,
  cwd: string,
  sessionId: string | undefined,
): Promise<SessionInfo | undefined> {
  try {
    const fileStat = await stat(transcriptPath);
    if (!fileStat.isFile()) return undefined;
    const id = sessionId ?? basename(transcriptPath).replace(/\.jsonl$/, "");
    return { provider, id, path: transcriptPath, cwd: resolve(cwd), modifiedAt: fileStat.mtime.toISOString() };
  } catch {
    return undefined;
  }
}

export type ConsolidationSpawner = (cwd: string, checkpointId: string, configPath?: string) => void;

// Fire-and-forget: a completely normal `cag memory consolidate-checkpoint`
// invocation, detached and unref'd so the hook (and the host agent's
// compaction) never waits on the LLM call. The child self-bounds via
// consolidationTimeoutMs inside consolidateBestEffort.
export function spawnDetachedConsolidation(cwd: string, checkpointId: string, configPath?: string): void {
  const entrypoint = fileURLToPath(new URL("../cli.js", import.meta.url));
  const args = [
    entrypoint,
    "memory",
    "consolidate-checkpoint",
    checkpointId,
    "--cwd",
    cwd,
    ...(configPath ? ["--config", configPath] : []),
  ];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();
}

// Token-free synchronous work only: resolve the session, write the
// checkpoint (which indexes into SQLite for free), then hand LLM
// consolidation to a detached child. Silent no-op when nothing resolves —
// a hook failure aborting the host agent's compaction is the worst outcome
// this module could cause.
export async function handlePreCompact(
  input: RawHookInput,
  cwd: string,
  provider: ProviderId,
  config: GatewayConfig,
  runner: CommandRunner,
  spawnConsolidation: ConsolidationSpawner = spawnDetachedConsolidation,
  configPath?: string,
): Promise<void> {
  let session: SessionInfo | undefined;
  // Fast path: the hook input names the exact transcript file, skipping the
  // full session-directory walk (the latency risk on large histories).
  if (input.transcriptPath) {
    session = await sessionFromTranscriptPath(provider, input.transcriptPath, cwd, input.sessionId);
  }
  if (!session) {
    try {
      session = await resolveSession(provider, cwd, input.sessionId ?? "latest");
    } catch {
      return;
    }
  }
  const checkpoint = await createCheckpoint(runner, session, { mode: "export", memoryConfig: config.memory });
  if (config.memory.enabled) spawnConsolidation(cwd, checkpoint.manifest.id, configPath);
}

// Deterministic per-prompt injection: top memory previews matched to the
// submitted prompt, capped hard. Empty output (not noise) when disabled,
// when nothing matches, or on runtimes without node:sqlite.
export async function handleUserPromptSubmit(
  input: RawHookInput,
  cwd: string,
  provider: ProviderId,
  config: GatewayConfig,
): Promise<string> {
  if (!config.memory.enabled || !config.memory.hooks.perPromptInjection) return "";
  const prompt = input.prompt?.trim() ?? "";
  if (!prompt) return "";
  const started = Date.now();
  try {
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return "";
    try {
      const hits = await search(memory, prompt, { limit: 5, scoring: config.memory.scoring });
      if (hits.length === 0) return "";
      const lines = hits.map((hit) => {
        const preview = toPreview(hit);
        return `- [${preview.source} ${preview.id}] ${preview.preview}`;
      });
      const header = "Relevant project memory (drill in with `cag memory show <id>` or the MCP memory_get tool):";
      // capText can emit maxChars + 1 (ellipsis appended after the slice) and
      // we add a trailing newline, so leave 2 chars of headroom to keep the
      // whole injection within the configured cap.
      const block = capText(`${header}\n${lines.join("\n")}`, config.memory.hooks.perPromptMaxChars - 2).text;
      recordLlmCall(memory, {
        purpose: "inject",
        provider,
        promptChars: prompt.length,
        outputChars: block.length,
        durationMs: Date.now() - started,
        ok: true,
      });
      return `${block}\n`;
    } finally {
      memory.close();
    }
  } catch {
    return "";
  }
}
