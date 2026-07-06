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
  role?: unknown;
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

// Cursor keys its per-project storage by a slugified absolute path
// (`/`→`-`, leading separator dropped). Only cwd→slug is deterministic —
// a directory name containing "-" makes the reverse ambiguous — so cursor
// and antigravity discovery both REQUIRE a cwd and return [] without one.
function cursorSlug(cwd: string): string {
  return resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\]/g, "-");
}

function cursorProjectsRoot(): string {
  return join(process.env.CURSOR_CONFIG_DIR ?? join(homedir(), ".cursor"), "projects");
}

function antigravityRoot(): string {
  return process.env.ANTIGRAVITY_CONFIG_DIR ?? join(homedir(), ".gemini", "antigravity-cli");
}

function byModifiedDesc(left: SessionInfo, right: SessionInfo): number {
  return Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt);
}

async function discoverCursorSessions(cwd: string | undefined): Promise<SessionInfo[]> {
  if (!cwd) return [];
  const wantedCwd = resolve(cwd);
  const transcripts = join(cursorProjectsRoot(), cursorSlug(wantedCwd), "agent-transcripts");
  const paths = await walkJsonl(transcripts);
  const sessions = await Promise.all(
    paths.map(async (path): Promise<SessionInfo | undefined> => {
      const id = path.split(/[\\/]/).at(-1)?.replace(/\.jsonl$/, "");
      if (!id) return undefined;
      try {
        const fileStat = await stat(path);
        return { provider: "cursor", id, path, cwd: wantedCwd, modifiedAt: fileStat.mtime.toISOString(), origin: "Cursor" };
      } catch {
        return undefined;
      }
    }),
  );
  return sessions.filter((session): session is SessionInfo => Boolean(session)).sort(byModifiedDesc);
}

// Discovery-only: `cache/last_conversations.json` maps absolute cwd → the
// current conversation id, and the conversation itself is a SQLite .db with
// an undocumented schema, so `extractTranscript` yields [] for antigravity.
// Knowing the id is still enough to resume via `agy --conversation <id>`.
async function discoverAntigravitySessions(cwd: string | undefined): Promise<SessionInfo[]> {
  if (!cwd) return [];
  const wantedCwd = resolve(cwd);
  const root = antigravityRoot();
  try {
    const raw = await readFile(join(root, "cache", "last_conversations.json"), "utf8");
    const conversations = JSON.parse(raw) as Record<string, unknown>;
    const id = conversations[wantedCwd];
    if (typeof id !== "string" || !id) return [];
    const path = join(root, "conversations", `${id}.db`);
    const fileStat = await stat(path);
    return [{ provider: "antigravity", id, path, cwd: wantedCwd, modifiedAt: fileStat.mtime.toISOString(), origin: "Antigravity" }];
  } catch {
    return [];
  }
}

export async function discoverSessions(provider: ProviderId, cwd?: string): Promise<SessionInfo[]> {
  if (provider === "cursor") return await discoverCursorSessions(cwd);
  if (provider === "antigravity") return await discoverAntigravitySessions(cwd);
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

// Cursor wraps the user's actual words in scaffolding: a <timestamp> header
// plus a <user_query> envelope. The interesting content is INSIDE the tags,
// so this unwraps rather than dropping the whole message like isInjected.
function cleanCursorText(text: string): string {
  const withoutTimestamp = text.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, "");
  const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(withoutTimestamp);
  return (query?.[1] ?? withoutTimestamp).trim();
}

export async function extractTranscript(session: SessionInfo): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];
  // Antigravity conversations are SQLite databases with an undocumented
  // schema, not JSONL — no transcript extraction yet (checkpoints degrade
  // to "Not available in the local transcript").
  if (session.provider === "antigravity") return messages;
  await forEachJsonLine(session.path, (event) => {
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : undefined;
    if (session.provider === "codex") {
      if (event.type !== "response_item" || !isRecord(event.payload) || event.payload.type !== "message") return;
      const role = event.payload.role;
      if (role !== "user" && role !== "assistant") return;
      for (const text of contentTexts(event.payload.content)) addMessage(messages, role, text, timestamp);
      return;
    }
    if (session.provider === "cursor") {
      const role = event.role;
      if ((role !== "user" && role !== "assistant") || !isRecord(event.message)) return;
      for (const text of contentTexts(event.message.content)) addMessage(messages, role, cleanCursorText(text), timestamp);
      return;
    }
    if ((event.type !== "user" && event.type !== "assistant") || !isRecord(event.message)) return;
    const role = event.message.role;
    if (role !== "user" && role !== "assistant") return;
    for (const text of contentTexts(event.message.content)) addMessage(messages, role, text, timestamp);
  });
  return messages;
}
