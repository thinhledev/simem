import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewayConfig } from "../config.js";
import { openMemoryDb } from "../memory/db.js";
import { recordLlmCall } from "../memory/ledger.js";
import { toPreview } from "../memory/preview.js";
import { automaticGate, search, vectorGateEnabled } from "../memory/retrieval.js";
import { resolveEmbeddings } from "../vec/client.js";
import { savingsTotals } from "../memory/savings.js";
import { capText } from "../memory/text-cap.js";
import type { CommandRunner } from "../process.js";
import type { ProviderId } from "../types.js";
import { buildBrief } from "./brief.js";
import { createCheckpoint } from "./checkpoints.js";
import { resolveSession } from "./sessions.js";
import type { SessionInfo } from "./types.js";
import type { SourceAgent } from "../sources/homes.js";
import { ingestTranscript, sessionKey, unreadBytes } from "../sources/ingest.js";
import { clearInjections, injectedRefs, recordInjections } from "../memory/injections.js";
import { sessionPrimer } from "../memory/primer.js";

export type HookEvent = "session-start" | "pre-compact" | "user-prompt-submit" | "stop" | "session-end" | "pre-tool-use";

export const HOOK_EVENTS: HookEvent[] = ["session-start", "pre-compact", "user-prompt-submit", "stop", "session-end", "pre-tool-use"];

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
  toolName?: string;
  toolInput?: Record<string, unknown>;
  permissionMode?: string;
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
    const toolName = firstString(record, ["tool_name", "toolName"]);
    const toolInput = record.tool_input ?? record.toolInput;
    const permissionMode = firstString(record, ["permission_mode", "permissionMode"]);
    return {
      ...(toolName !== undefined ? { toolName } : {}),
      ...(toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? { toolInput: toolInput as Record<string, unknown> } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
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
// plain resume is suppressed: mixai's CLAUDE.local.md block already @imports
// the lean .mixai/current/BRIEF.md (objective + pointer) as persistent context,
// which is enough to re-orient a resume; the fuller brief (live git + memory)
// stays one `mixai brief` away. "compact"/"clear" still get the full brief here
// because those lose more context and its live state isn't in the import.
export async function handleSessionStart(
  input: RawHookInput,
  cwd: string,
  provider: ProviderId,
  config: GatewayConfig,
  runner: CommandRunner,
): Promise<string> {
  if (!config.memory.hooks.sessionStartBrief) return "";
  const source = input.source ?? "";
  const agent = PROVIDER_SOURCE_AGENT[provider];
  const key = agent && input.sessionId ? sessionKey(agent, input.sessionId) : undefined;
  if (source === "startup") {
    // A fresh session: the primer replaces the usual exploration turns.
    if (!config.memory.enabled) return "";
    try {
      return await sessionPrimer(cwd, config.memory, { ...(key ? { sessionKey: key } : {}) });
    } catch {
      return "";
    }
  }
  if (!REVIVAL_SOURCES.has(source)) return "";
  if (key && (source === "compact" || source === "clear")) {
    // The context window was emptied: memory may be shown again.
    try {
      const memory = await openMemoryDb(cwd, { quiet: true });
      if (memory) {
        try {
          clearInjections(memory, key);
        } finally {
          memory.close();
        }
      }
    } catch {
      // Best-effort.
    }
  }
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

// Fire-and-forget: a completely normal `mixai memory consolidate-checkpoint`
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

// Cumulative measured savings so far (compaction, disclosure, prompt caps) —
// the same numbers `mixai memory savings` reports, computed fresh each call so
// it's never stale. Empty when disabled, nothing has been measured yet, or
// the runtime lacks node:sqlite — never noise, matching every other hook.
export async function taskCompletionSavingsLine(cwd: string, config: GatewayConfig): Promise<string> {
  if (!config.memory.enabled || !config.memory.hooks.taskCompletionSavings) return "";
  try {
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return "";
    try {
      const totals = savingsTotals(memory);
      if (totals.events === 0) return "";
      return (
        `[mixai] measured savings so far: ~${totals.estimatedTokensSaved} tokens ` +
        `(${totals.charsSaved} chars) across ${totals.events} event(s). Run \`mixai memory savings\` for a breakdown.`
      );
    } finally {
      memory.close();
    }
  } catch {
    return "";
  }
}

// Claude Code / Codex "Stop" (task-completion) hook: reports cumulative
// measured savings so it's visible without the user remembering to run
// `mixai memory savings`. Side-effect-free — pure read of already-recorded data.
export async function handleStop(cwd: string, config: GatewayConfig): Promise<string> {
  const line = await taskCompletionSavingsLine(cwd, config);
  return line ? `${line}\n` : "";
}

export interface MemoryContextBlock {
  /** Formatted memory block ready to prepend to a prompt; "" when there was nothing to add. */
  block: string;
  /** Number of memory hits incorporated into `block`. */
  hitCount: number;
}

// Deterministic per-prompt retrieval: top memory previews matched to the
// submitted prompt, capped hard. Shared by the UserPromptSubmit hook (below)
// and `mixai run` (cli.ts), which both want the same "search once, format
// once" behavior but attribute the ledger row differently. Empty result
// (not noise) when disabled, when nothing matches, or on runtimes without
// node:sqlite. Searches memory_items/summaries only (excludeMessages) — raw
// checkpoint messages are excluded from this automatic path because they're
// noisy for something injected unattended into every prompt (e.g. a new
// prompt can literally match an earlier, near-identical question verbatim,
// echoing the user's own words back as "relevant context"). A deliberate
// `mixai memory search` still searches messages too.
export async function buildMemoryContextBlock(
  cwd: string,
  prompt: string,
  config: GatewayConfig,
  sessionKeyForDedupe?: string,
): Promise<MemoryContextBlock> {
  const empty: MemoryContextBlock = { block: "", hitCount: 0 };
  if (!config.memory.enabled || !config.memory.hooks.perPromptInjection) return empty;
  const trimmed = prompt.trim();
  if (!trimmed) return empty;
  try {
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return empty;
    try {
      // Vectors join the automatic gate only when cutoffs were calibrated
      // for the model; otherwise skip loading the model on every prompt.
      const embeddings = vectorGateEnabled(config.memory.embeddings) ? await resolveEmbeddings(config.memory) : undefined;
      const hits = await search(memory, trimmed, {
        limit: 5,
        scoring: config.memory.scoring,
        excludeMessages: true,
        ...automaticGate(config.memory.embeddings),
        ...(embeddings ? { embeddings } : {}),
      });
      // Never re-inject what this session's context already holds (the
      // primer or an earlier prompt's injection).
      const already = sessionKeyForDedupe ? injectedRefs(memory, sessionKeyForDedupe) : new Set<string>();
      const fresh = hits.filter((hit) => !already.has(`${hit.source}:${hit.id}`));
      if (fresh.length === 0) return empty;
      if (sessionKeyForDedupe) recordInjections(memory, sessionKeyForDedupe, fresh.map((hit) => `${hit.source}:${hit.id}`));
      const lines = fresh.map((hit) => {
        const preview = toPreview(hit);
        return `- [${preview.source} ${preview.id}] ${preview.preview}`;
      });
      const header = "Relevant project memory (drill in with `mixai memory show <id>` or the MCP memory_get tool):";
      // capText can emit maxChars + 1 (ellipsis appended after the slice) and
      // we add a trailing newline, so leave 2 chars of headroom to keep the
      // whole injection within the configured cap.
      const block = capText(`${header}\n${lines.join("\n")}`, config.memory.hooks.perPromptMaxChars - 2).text;
      return { block: `${block}\n`, hitCount: fresh.length };
    } finally {
      memory.close();
    }
  } catch {
    return empty;
  }
}

// Records the injection in the token ledger — "inject" rows are char
// accounting, not billable LLM usage (see ledger.ts), so callers can attach
// whichever provider actually ended up using the injected context.
export async function recordMemoryInjection(
  cwd: string,
  provider: ProviderId,
  promptChars: number,
  outputChars: number,
  durationMs: number,
): Promise<void> {
  try {
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return;
    try {
      recordLlmCall(memory, { purpose: "inject", provider, promptChars, outputChars, durationMs, ok: true });
    } finally {
      memory.close();
    }
  } catch {
    // Ledger is additive; a recording failure must never affect the caller.
  }
}

// Deterministic per-prompt injection for the UserPromptSubmit hook: top
// memory previews matched to the submitted prompt, capped hard. Empty
// output (not noise) when disabled, when nothing matches, or on runtimes
// without node:sqlite.
export async function handleUserPromptSubmit(
  input: RawHookInput,
  cwd: string,
  provider: ProviderId,
  config: GatewayConfig,
): Promise<string> {
  const prompt = input.prompt?.trim() ?? "";
  if (!prompt) return "";
  const started = Date.now();
  const agent = PROVIDER_SOURCE_AGENT[provider];
  const key = agent && input.sessionId ? sessionKey(agent, input.sessionId) : undefined;
  const { block, hitCount } = await buildMemoryContextBlock(cwd, prompt, config, key);
  if (hitCount === 0) return "";
  await recordMemoryInjection(cwd, provider, prompt.length, block.length, Date.now() - started);
  return block;
}

const PROVIDER_SOURCE_AGENT: Partial<Record<ProviderId, SourceAgent>> = { claude: "claude", codex: "codex", cursor: "cursor" };

// Above this many unread bytes, ingestion moves to a detached child so a
// hook never stalls the host agent (e.g. the first capture of a long session).
const INLINE_INGEST_MAX_BYTES = 2 * 1024 * 1024;

export type IngestSpawner = (path: string, agent: SourceAgent, configPath?: string) => void;

export function spawnDetachedIngest(path: string, agent: SourceAgent, configPath?: string): void {
  const entrypoint = fileURLToPath(new URL("../cli.js", import.meta.url));
  const args = [entrypoint, "sync", "--path", path, "--provider", agent, "--quiet", ...(configPath ? ["--config", configPath] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: { ...process.env, MIXAI_INTERNAL: "1" } });
  child.unref();
}

// Continuous capture for Stop / SessionEnd / PreCompact: the session's own
// transcript is ingested (new bytes only), distilled with the zero-token
// rules tier, and becomes project memory — no switch or export needed.
export async function captureSession(
  input: RawHookInput,
  provider: ProviderId,
  config: GatewayConfig,
  spawnIngest: IngestSpawner = spawnDetachedIngest,
  configPath?: string,
): Promise<void> {
  if (!config.memory.enabled) return;
  const agent = PROVIDER_SOURCE_AGENT[provider];
  if (!agent || !input.transcriptPath) return;
  try {
    const info = await stat(input.transcriptPath);
    if (info.size > INLINE_INGEST_MAX_BYTES && (await unreadBytes(input.transcriptPath, info.size)) > INLINE_INGEST_MAX_BYTES) {
      spawnIngest(input.transcriptPath, agent, configPath);
      return;
    }
    await ingestTranscript({ agent, path: input.transcriptPath }, { memoryConfig: config.memory });
  } catch {
    // Capture is additive; never fail the host agent's lifecycle event.
  }
}

// PreToolUse: output compression and read guards (see guards.ts). Empty
// output leaves the tool call to the host's normal permission flow.
export async function handlePreToolUse(input: RawHookInput, cwd: string, provider: ProviderId, config: GatewayConfig): Promise<string> {
  try {
    const { decidePreToolUse } = await import("../compress/guards.js");
    const decision = await decidePreToolUse(input, cwd, provider, config);
    return decision ? `${JSON.stringify(decision)}\n` : "";
  } catch {
    return "";
  }
}
