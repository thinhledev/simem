import { open } from "node:fs/promises";
import { cleanCursorText, contentTexts, isInjected } from "../handoff/sessions.js";
import type { SourceAgent } from "./homes.js";

// Incremental, zero-token transcript parsing. Reads only bytes after
// `offset`, and only whole lines, so it can run on every Stop hook against a
// transcript that is still being written.

export type EventType = "read" | "edit" | "command" | "search" | "mcp" | "other";

export interface ParsedMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

export interface ParsedUsage {
  key: string;
  ts?: string;
  model?: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface ParsedEvent {
  callId?: string;
  ts?: string;
  type: EventType;
  tool: string;
  target?: string;
}

export interface ParsedResult {
  callId: string;
  bytes: number;
  ok: boolean;
  exitCode?: number;
}

export interface TranscriptMeta {
  sessionId?: string | undefined;
  cwd?: string | undefined;
  title?: string | undefined;
  /** app | cli | headless | unknown */
  surface?: string | undefined;
  model?: string | undefined;
  firstTimestamp?: string | undefined;
  lastTimestamp?: string | undefined;
}

export interface ParsedChunk {
  messages: ParsedMessage[];
  usage: ParsedUsage[];
  events: ParsedEvent[];
  results: ParsedResult[];
  meta: TranscriptMeta;
  /** Byte offset just past the last complete line consumed. */
  nextOffset: number;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

const NOISE_MESSAGES = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);

function pushMessage(chunk: ParsedChunk, role: "user" | "assistant", text: string, timestamp?: string): void {
  const cleaned = text.trim();
  if (!cleaned || isInjected(cleaned) || NOISE_MESSAGES.has(cleaned)) return;
  const previous = chunk.messages.at(-1);
  if (previous?.role === role && previous.text === cleaned) return;
  chunk.messages.push({ role, text: cleaned, ...(timestamp ? { timestamp } : {}) });
}

function classifyClaudeTool(name: string, input: Json): { type: EventType; target?: string } {
  const filePath = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  if (name === "Read") return { type: "read", ...(filePath ? { target: filePath } : {}) };
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) return { type: "edit", ...(filePath ? { target: filePath } : {}) };
  if (name === "Bash") {
    const command = str(input.command);
    return { type: "command", ...(command ? { target: command } : {}) };
  }
  if (name === "Grep" || name === "Glob") {
    const pattern = str(input.pattern);
    return { type: "search", ...(pattern ? { target: pattern } : {}) };
  }
  if (name.startsWith("mcp__")) return { type: "mcp", target: name };
  return { type: "other" };
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum: number, item) => sum + (isRecord(item) && typeof item.text === "string" ? item.text.length : 0), 0);
  }
  return 0;
}

function surfaceFromClaudeEntrypoint(entrypoint: string): string {
  if (entrypoint === "claude-desktop" || entrypoint === "claude-vscode") return "app";
  if (entrypoint === "cli") return "cli";
  if (entrypoint.startsWith("sdk")) return "headless";
  return "unknown";
}

function parseClaudeLine(event: Json, chunk: ParsedChunk, state: ParseState): void {
  const timestamp = str(event.timestamp);
  const meta = chunk.meta;
  if (!meta.sessionId && str(event.sessionId)) meta.sessionId = str(event.sessionId);
  if (!meta.cwd && str(event.cwd)) meta.cwd = str(event.cwd);
  if (str(event.entrypoint) && !meta.surface) meta.surface = surfaceFromClaudeEntrypoint(str(event.entrypoint)!);
  if (event.type === "custom-title" && str(event.customTitle)) {
    meta.title = str(event.customTitle);
    state.customTitle = true;
  }
  if (event.type === "ai-title" && str(event.aiTitle) && !state.customTitle) meta.title = str(event.aiTitle);
  if (timestamp) {
    meta.firstTimestamp ??= timestamp;
    meta.lastTimestamp = timestamp;
  }
  if (event.isSidechain === true || event.isMeta === true) return;
  if ((event.type !== "user" && event.type !== "assistant") || !isRecord(event.message)) return;
  const message = event.message;
  const content = message.content;
  if (event.type === "assistant") {
    if (str(message.model) && message.model !== "<synthetic>") meta.model = str(message.model);
    // Claude Code writes one line per content block, repeating the message
    // id and its usage on each — count usage once per message id.
    const usage = message.usage;
    const id = str(message.id);
    if (isRecord(usage) && id) {
      chunk.usage.push({
        key: id,
        ...(timestamp ? { ts: timestamp } : {}),
        ...(str(message.model) ? { model: str(message.model)! } : {}),
        input: num(usage.input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens),
        output: num(usage.output_tokens),
      });
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_use" && str(block.name)) {
          const classified = classifyClaudeTool(str(block.name)!, isRecord(block.input) ? block.input : {});
          chunk.events.push({
            ...(str(block.id) ? { callId: str(block.id)! } : {}),
            ...(timestamp ? { ts: timestamp } : {}),
            tool: str(block.name)!,
            ...classified,
          });
        }
      }
    }
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (isRecord(block) && block.type === "tool_result" && str(block.tool_use_id)) {
        chunk.results.push({ callId: str(block.tool_use_id)!, bytes: textLength(block.content), ok: block.is_error !== true });
      }
    }
  }
  const role = message.role;
  if (role !== "user" && role !== "assistant") return;
  for (const text of contentTexts(content)) pushMessage(chunk, role, text, timestamp);
}

function surfaceFromCodexOriginator(originator: string): string {
  if (originator === "Codex Desktop") return "app";
  if (originator === "codex_exec") return "headless";
  if (originator.startsWith("codex_cli") || originator === "codex-tui") return "cli";
  return "unknown";
}

function codexExitCode(output: string): number | undefined {
  const match = /(?:Process exited with code|Exit code:)\s*(-?\d+)/.exec(output);
  return match ? Number(match[1]) : undefined;
}

function patchTargets(patch: string): string | undefined {
  const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]?.trim()).filter(Boolean);
  return files.length > 0 ? files.join(", ") : undefined;
}

function parseCodexLine(event: Json, chunk: ParsedChunk, state: ParseState): void {
  const timestamp = str(event.timestamp);
  const meta = chunk.meta;
  if (timestamp) {
    meta.firstTimestamp ??= timestamp;
    meta.lastTimestamp = timestamp;
  }
  const payload = isRecord(event.payload) ? event.payload : undefined;
  if (!payload) return;
  if (event.type === "session_meta") {
    meta.sessionId ??= str(payload.session_id) ?? str(payload.id);
    meta.cwd ??= str(payload.cwd);
    if (str(payload.originator)) meta.surface = surfaceFromCodexOriginator(str(payload.originator)!);
    return;
  }
  if (event.type === "turn_context") {
    if (str(payload.model)) meta.model = str(payload.model);
    return;
  }
  if (event.type === "event_msg" && payload.type === "token_count" && isRecord(payload.info)) {
    const total = isRecord(payload.info.total_token_usage) ? payload.info.total_token_usage : undefined;
    const last = isRecord(payload.info.last_token_usage) ? payload.info.last_token_usage : undefined;
    if (!total || !last) return;
    // token_count repeats with unchanged totals; the running total is the key.
    const key = `total:${num(total.total_tokens)}`;
    if (state.codexUsageKeys.has(key)) return;
    state.codexUsageKeys.add(key);
    const input = num(last.input_tokens);
    const cached = num(last.cached_input_tokens);
    chunk.usage.push({
      key,
      ...(timestamp ? { ts: timestamp } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      // OpenAI input_tokens include the cached part; split it out.
      input: Math.max(0, input - cached),
      cacheRead: cached,
      cacheWrite: num(last.cache_write_input_tokens),
      output: num(last.output_tokens) + num(last.reasoning_output_tokens),
    });
    return;
  }
  if (event.type !== "response_item") return;
  if (payload.type === "message") {
    const role = payload.role;
    if (role !== "user" && role !== "assistant") return;
    for (const text of contentTexts(payload.content)) pushMessage(chunk, role, text, timestamp);
    return;
  }
  const callId = str(payload.call_id);
  if (payload.type === "function_call" && str(payload.name)) {
    let args: Json = {};
    try {
      const parsed = JSON.parse(str(payload.arguments) ?? "{}") as unknown;
      if (isRecord(parsed)) args = parsed;
    } catch {
      // Unparseable arguments still count as an event.
    }
    const name = str(payload.name)!;
    const command = Array.isArray(args.cmd) ? args.cmd.join(" ") : str(args.cmd) ?? (Array.isArray(args.command) ? args.command.join(" ") : str(args.command));
    const isShell = name === "exec_command" || name === "shell" || name === "local_shell";
    chunk.events.push({
      ...(callId ? { callId } : {}),
      ...(timestamp ? { ts: timestamp } : {}),
      tool: name,
      type: isShell ? "command" : name.startsWith("mcp__") ? "mcp" : "other",
      ...(isShell && command ? { target: command } : {}),
    });
    return;
  }
  if (payload.type === "custom_tool_call" && str(payload.name)) {
    const target = str(payload.name) === "apply_patch" ? patchTargets(str(payload.input) ?? "") : undefined;
    chunk.events.push({
      ...(callId ? { callId } : {}),
      ...(timestamp ? { ts: timestamp } : {}),
      tool: str(payload.name)!,
      type: str(payload.name) === "apply_patch" ? "edit" : "other",
      ...(target ? { target } : {}),
    });
    return;
  }
  if ((payload.type === "function_call_output" || payload.type === "custom_tool_call_output") && callId) {
    const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
    const exitCode = codexExitCode(output);
    chunk.results.push({ callId, bytes: output.length, ok: exitCode === undefined ? true : exitCode === 0, ...(exitCode !== undefined ? { exitCode } : {}) });
  }
}

function parseCursorLine(event: Json, chunk: ParsedChunk): void {
  const role = event.role;
  if ((role !== "user" && role !== "assistant") || !isRecord(event.message)) return;
  for (const text of contentTexts(event.message.content)) pushMessage(chunk, role, cleanCursorText(text));
}

interface ParseState {
  customTitle: boolean;
  codexUsageKeys: Set<string>;
}

const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

export async function parseTranscriptFrom(agent: SourceAgent, path: string, offset: number): Promise<ParsedChunk> {
  const chunk: ParsedChunk = { messages: [], usage: [], events: [], results: [], meta: {}, nextOffset: offset };
  const handle = await open(path, "r");
  let buffer: Buffer;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size - offset, MAX_CHUNK_BYTES);
    if (length <= 0) return chunk;
    buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
  } finally {
    await handle.close();
  }
  // Only whole lines: a line still being written is picked up next time.
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) return chunk;
  const text = buffer.subarray(0, lastNewline + 1).toString("utf8");
  chunk.nextOffset = offset + lastNewline + 1;
  const state: ParseState = { customTitle: false, codexUsageKeys: new Set() };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (agent === "claude") parseClaudeLine(event, chunk, state);
    else if (agent === "codex") parseCodexLine(event, chunk, state);
    else parseCursorLine(event, chunk);
  }
  return chunk;
}

// Session id and cwd from the first lines only — cheap enough to run for
// every transcript during a sync, to decide which project it belongs to.
export async function readTranscriptHeader(agent: SourceAgent, path: string): Promise<TranscriptMeta> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const meta: TranscriptMeta = {};
    const state: ParseState = { customTitle: false, codexUsageKeys: new Set() };
    const scratch: ParsedChunk = { messages: [], usage: [], events: [], results: [], meta, nextOffset: 0 };
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (meta.sessionId && meta.cwd) break;
      try {
        const event = JSON.parse(line) as unknown;
        if (!isRecord(event)) continue;
        if (agent === "claude") parseClaudeLine(event, scratch, state);
        else if (agent === "codex") parseCodexLine(event, scratch, state);
      } catch {
        // Partial or non-JSON line.
      }
    }
    return meta;
  } finally {
    await handle.close();
  }
}
