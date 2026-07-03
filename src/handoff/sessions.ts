import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ProviderId } from "../types.js";
import type { SessionInfo, TranscriptMessage } from "./types.js";

interface JsonRecord {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  message?: unknown;
}

const INJECTED_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<permissions instructions>",
  "<app-context>",
  "<collaboration_mode>",
  "<personality_spec>",
  "<skills_instructions>",
  "<plugins_instructions>",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isInjected(text: string): boolean {
  const trimmed = text.trimStart();
  return INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

async function walkFiles(root: string, suffix: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
      }),
    );
  }
  await walk(root);
  return files;
}

async function walkJsonl(root: string): Promise<string[]> {
  return await walkFiles(root, ".jsonl");
}

interface ClaudeDesktopSession {
  cliSessionId: string;
  originCwd: string;
}

async function claudeDesktopSessions(): Promise<Map<string, ClaudeDesktopSession>> {
  if (process.platform !== "darwin" && !process.env.CLAUDE_DESKTOP_DATA_DIR) return new Map();
  const root = process.env.CLAUDE_DESKTOP_DATA_DIR
    ?? join(homedir(), "Library", "Application Support", "Claude");
  const paths = await walkFiles(join(root, "claude-code-sessions"), ".json");
  const entries = await Promise.all(
    paths.map(async (path): Promise<ClaudeDesktopSession | undefined> => {
      try {
        const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        if (typeof value.cliSessionId !== "string" || typeof value.originCwd !== "string") return undefined;
        return { cliSessionId: value.cliSessionId, originCwd: resolve(value.originCwd) };
      } catch {
        return undefined;
      }
    }),
  );
  return new Map(
    entries
      .filter((entry): entry is ClaudeDesktopSession => Boolean(entry))
      .map((entry) => [entry.cliSessionId, entry]),
  );
}

async function forEachJsonLine(
  path: string,
  callback: (value: JsonRecord) => boolean | void,
): Promise<void> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      try {
        const shouldStop = callback(JSON.parse(line) as JsonRecord);
        if (shouldStop) break;
      } catch {
        // A partial or future event must not make the whole local session unreadable.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function contentTexts(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!isRecord(item)) return [];
    const type = typeof item.type === "string" ? item.type : "";
    if (!["text", "input_text", "output_text"].includes(type)) return [];
    return typeof item.text === "string" && item.text.trim() ? [item.text] : [];
  });
}

async function codexHeader(path: string): Promise<Omit<SessionInfo, "provider" | "modifiedAt" | "path"> | undefined> {
  let header: Omit<SessionInfo, "provider" | "modifiedAt" | "path"> | undefined;
  await forEachJsonLine(path, (event) => {
    if (event.type !== "session_meta" || !isRecord(event.payload)) return false;
    const id = event.payload.session_id ?? event.payload.id;
    if (typeof id !== "string" || typeof event.payload.cwd !== "string") return true;
    header = {
      id,
      cwd: resolve(event.payload.cwd),
      ...(typeof event.payload.timestamp === "string" ? { createdAt: event.payload.timestamp } : {}),
      ...(typeof event.payload.originator === "string" ? { origin: event.payload.originator } : {}),
    };
    return true;
  });
  return header;
}

async function claudeHeader(path: string): Promise<Omit<SessionInfo, "provider" | "modifiedAt" | "path"> | undefined> {
  let id: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  await forEachJsonLine(path, (event) => {
    if (!id && typeof event.sessionId === "string") id = event.sessionId;
    if (!cwd && typeof event.cwd === "string") cwd = resolve(event.cwd);
    if (!createdAt && typeof event.timestamp === "string") createdAt = event.timestamp;
    return Boolean(id && cwd);
  });
  if (!id) id = path.split("/").at(-1)?.replace(/\.jsonl$/, "");
  if (!id || !cwd) return undefined;
  return { id, cwd, ...(createdAt ? { createdAt } : {}), origin: "Claude Code" };
}

function sessionRoot(provider: ProviderId): string | undefined {
  if (provider === "codex") return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  if (provider === "claude") return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  return undefined;
}

export async function discoverSessions(provider: ProviderId, cwd?: string): Promise<SessionInfo[]> {
  const root = sessionRoot(provider);
  if (!root) return [];
  const wantedCwd = cwd ? resolve(cwd) : undefined;
  const paths = await walkJsonl(root);
  const desktopSessions = provider === "claude" ? await claudeDesktopSessions() : new Map<string, ClaudeDesktopSession>();
  const sessions = await Promise.all(
    paths.map(async (path): Promise<SessionInfo | undefined> => {
      if (provider === "claude" && path.split(/[\\/]/).includes("subagents")) return undefined;
      const fileStat = await stat(path);
      const header = provider === "codex" ? await codexHeader(path) : await claudeHeader(path);
      if (!header) return undefined;
      const desktopSession = provider === "claude" ? desktopSessions.get(header.id) : undefined;
      const effectiveCwd = desktopSession?.originCwd ?? header.cwd;
      if (wantedCwd && effectiveCwd !== wantedCwd) return undefined;
      return {
        provider,
        path,
        modifiedAt: fileStat.mtime.toISOString(),
        ...header,
        cwd: effectiveCwd,
        ...(desktopSession ? { origin: "Claude Code Desktop" } : {}),
      };
    }),
  );
  return sessions
    .filter((session): session is SessionInfo => Boolean(session))
    .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
}

export async function resolveSession(
  provider: ProviderId,
  cwd: string,
  selector = "latest",
): Promise<SessionInfo> {
  const sessions = await discoverSessions(provider, cwd);
  const session = selector === "latest" ? sessions[0] : sessions.find((item) => item.id === selector);
  if (!session) {
    throw new Error(`No ${provider} session ${selector === "latest" ? "was found" : `matched ${selector}`} for ${resolve(cwd)}`);
  }
  return session;
}

function addMessage(messages: TranscriptMessage[], role: "user" | "assistant", text: string, timestamp?: string): void {
  const cleaned = text.trim();
  if (!cleaned || isInjected(cleaned)) return;
  const previous = messages.at(-1);
  if (previous?.role === role && previous.text === cleaned) return;
  messages.push({ role, text: cleaned, ...(timestamp ? { timestamp } : {}) });
}

export async function extractTranscript(session: SessionInfo): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];
  await forEachJsonLine(session.path, (event) => {
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
    if (session.provider === "codex") {
      if (event.type !== "response_item" || !isRecord(event.payload) || event.payload.type !== "message") return;
      const role = event.payload.role;
      if (role !== "user" && role !== "assistant") return;
      for (const text of contentTexts(event.payload.content)) addMessage(messages, role, text, timestamp);
      return;
    }
    if ((event.type !== "user" && event.type !== "assistant") || !isRecord(event.message)) return;
    const role = event.message.role;
    if (role !== "user" && role !== "assistant") return;
    for (const text of contentTexts(event.message.content)) addMessage(messages, role, text, timestamp);
  });
  return messages;
}
