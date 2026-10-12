import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, type MemoryConfig } from "../config.js";
import { consolidateCheckpoint } from "../memory/consolidate.js";
import { openMemoryDb, type MemoryDb } from "../memory/db.js";
import { isInternalMemoryPrompt } from "../memory/internal-prompt.js";
import { recordRedactions } from "../memory/counters.js";
import { sanitize } from "../memory/sanitize.js";
import { embedNewRows } from "../vec/client.js";
import { openGlobalDb } from "../store/global-db.js";
import { resolveProject } from "../store/project.js";
import { discoverHomes, type AgentHome, type SourceAgent } from "./homes.js";
import { parseTranscriptFrom, readTranscriptHeader, type ParsedChunk } from "./transcript.js";

export interface TranscriptFile {
  agent: SourceAgent;
  path: string;
  sourceDir?: string;
}

export interface IngestResult {
  status: "ingested" | "unchanged" | "skipped";
  path: string;
  sessionKey?: string;
  projectId?: string;
  messages: number;
  usage: number;
  events: number;
  reason?: string;
}

interface CursorRow {
  inode: number;
  offset: number;
  session_id: string | null;
  cwd: string | null;
  project_id: string | null;
  ignored: number;
}

// How many bytes of a transcript have not been ingested yet (whole file if never seen).
export async function unreadBytes(path: string, size: number): Promise<number> {
  const global = openGlobalDb();
  if (!global) return size;
  try {
    const row = global.prepare("SELECT offset FROM ingest_cursors WHERE path = ?").get(path) as { offset: number } | undefined;
    return Math.max(0, size - (row?.offset ?? 0));
  } finally {
    global.close();
  }
}

export function sessionKey(agent: string, externalId: string): string {
  return `session:${agent}:${externalId}`;
}

function writeChunk(memory: MemoryDb, file: TranscriptFile, key: string, externalId: string, cwd: string, chunk: ParsedChunk, reset: boolean): void {
  const now = new Date().toISOString();
  const startedAt = chunk.meta.firstTimestamp ?? now;
  const lastActivity = chunk.meta.lastTimestamp ?? startedAt;
  memory.db.exec("BEGIN");
  try {
    memory.db
      .prepare(
        `INSERT OR IGNORE INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json)
         VALUES (?, ?, ?, ?, ?, 'session', '', '{}')`,
      )
      .run(key, startedAt, cwd, file.agent, externalId);
    if (reset) {
      memory.db.prepare("DELETE FROM messages WHERE checkpoint_id = ?").run(key);
      memory.db.prepare("DELETE FROM events WHERE session_id = ?").run(key);
      memory.db.prepare("DELETE FROM turn_usage WHERE session_id = ?").run(key);
    }
    memory.db
      .prepare(
        `INSERT INTO sessions (id, agent, external_id, source_dir, surface, cwd, title, model, transcript_path, started_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           surface = CASE WHEN excluded.surface = 'unknown' THEN sessions.surface ELSE excluded.surface END,
           title = COALESCE(excluded.title, sessions.title),
           model = COALESCE(excluded.model, sessions.model),
           transcript_path = excluded.transcript_path,
           last_activity_at = MAX(sessions.last_activity_at, excluded.last_activity_at)`,
      )
      .run(
        key,
        file.agent,
        externalId,
        file.sourceDir ?? null,
        chunk.meta.surface ?? "unknown",
        cwd,
        chunk.meta.title ?? null,
        chunk.meta.model ?? null,
        file.path,
        startedAt,
        lastActivity,
      );
    const maxSeq = memory.db.prepare("SELECT COALESCE(MAX(seq), -1) AS seq FROM messages WHERE checkpoint_id = ?").get(key) as { seq: number };
    const insertMessage = memory.db.prepare("INSERT INTO messages (checkpoint_id, seq, role, text, timestamp) VALUES (?, ?, ?, ?, ?)");
    let seq = maxSeq.seq;
    const redactions: Record<string, number> = {};
    for (const message of chunk.messages) {
      const clean = sanitize(message.text);
      for (const [kind, count] of Object.entries(clean.redactions)) redactions[kind] = (redactions[kind] ?? 0) + count;
      seq += 1;
      insertMessage.run(key, seq, message.role, clean.text, message.timestamp ?? null);
    }
    recordRedactions(memory, redactions);
    const insertUsage = memory.db.prepare(
      `INSERT OR IGNORE INTO turn_usage (session_id, usage_key, ts, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const usage of chunk.usage) {
      insertUsage.run(key, usage.key, usage.ts ?? null, usage.model ?? null, usage.input, usage.cacheRead, usage.cacheWrite, usage.output);
    }
    const insertEvent = memory.db.prepare(
      "INSERT INTO events (session_id, call_id, ts, type, tool, target) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const event of chunk.events) {
      const target = event.target ? sanitize(event.target).text.slice(0, 500) : null;
      insertEvent.run(key, event.callId ?? null, event.ts ?? null, event.type, event.tool, target);
    }
    const applyResult = memory.db.prepare("UPDATE events SET bytes = ?, ok = ?, exit_code = ? WHERE session_id = ? AND call_id = ?");
    for (const result of chunk.results) {
      applyResult.run(result.bytes, result.ok ? 1 : 0, result.exitCode ?? null, key, result.callId);
    }
    if (chunk.messages.length > 0) {
      memory.db
        .prepare("UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE checkpoint_id = ?) WHERE id = ?")
        .run(key, key);
      memory.db.prepare("UPDATE checkpoints SET consolidation_status = 'pending' WHERE id = ?").run(key);
    }
    memory.db.exec("COMMIT");
  } catch (error) {
    memory.db.exec("ROLLBACK");
    throw error;
  }
}

// Ingests the new part of one transcript into its project's store (the
// project is resolved from the session's own cwd, so a sync can cover every
// project on the machine). Cursors live in global.db; re-running is a no-op.
// mixai's own headless consolidation runs are recognised and skipped.
export async function ingestTranscript(
  file: TranscriptFile,
  options: { memoryConfig?: MemoryConfig; distill?: boolean; onlyProjectId?: string } = {},
): Promise<IngestResult> {
  const empty = { path: file.path, messages: 0, usage: 0, events: 0 };
  let info;
  try {
    info = await stat(file.path);
  } catch {
    return { ...empty, status: "skipped", reason: "missing" };
  }
  const global = openGlobalDb();
  if (!global) return { ...empty, status: "skipped", reason: "node:sqlite unavailable" };
  try {
    const cursor = global
      .prepare("SELECT inode, offset, session_id, cwd, project_id, ignored FROM ingest_cursors WHERE path = ?")
      .get(file.path) as CursorRow | undefined;
    const sameFile = cursor && cursor.inode === info.ino && info.size >= cursor.offset;
    if (sameFile && cursor.offset === info.size) return { ...empty, status: "unchanged" };
    if (sameFile && cursor.ignored) {
      global.prepare("UPDATE ingest_cursors SET offset = ?, updated_at = ? WHERE path = ?").run(info.size, new Date().toISOString(), file.path);
      return { ...empty, status: "skipped", reason: "ignored session" };
    }
    const offset = sameFile ? cursor.offset : 0;
    const reset = Boolean(cursor) && offset === 0;
    const header = offset === 0 || !cursor?.cwd || !cursor.session_id ? await readTranscriptHeader(file.agent, file.path) : undefined;
    const externalId = header?.sessionId ?? cursor?.session_id ?? file.path.split(/[\\/]/).at(-1)?.replace(/\.jsonl$/, "");
    const cwd = header?.cwd ?? cursor?.cwd ?? undefined;
    if (!externalId || !cwd) return { ...empty, status: "skipped", reason: "no session id or cwd" };
    const project = resolveProject(cwd);
    if (options.onlyProjectId && project.id !== options.onlyProjectId) {
      return { ...empty, status: "skipped", reason: "other project" };
    }
    const chunk = await parseTranscriptFrom(file.agent, file.path, offset);
    chunk.meta.cwd ??= cwd;
    const firstUser = chunk.messages.find((message) => message.role === "user");
    const ignored = offset === 0 && firstUser !== undefined && isInternalMemoryPrompt(firstUser.text);
    const now = new Date().toISOString();
    const saveCursor = global.prepare(
      `INSERT INTO ingest_cursors (path, agent, inode, offset, session_id, cwd, project_id, ignored, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET inode = excluded.inode, offset = excluded.offset, session_id = excluded.session_id,
         cwd = excluded.cwd, project_id = excluded.project_id, ignored = excluded.ignored, updated_at = excluded.updated_at`,
    );
    if (ignored) {
      saveCursor.run(file.path, file.agent, info.ino, info.size, externalId, cwd, project.id, 1, now);
      return { ...empty, status: "skipped", reason: "mixai internal run" };
    }
    const key = sessionKey(file.agent, externalId);
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return { ...empty, status: "skipped", reason: "memory unavailable" };
    try {
      writeChunk(memory, file, key, externalId, cwd, chunk, reset);
      saveCursor.run(file.path, file.agent, info.ino, chunk.nextOffset, externalId, cwd, project.id, 0, now);
      if (options.distill !== false && chunk.messages.length > 0) {
        await consolidateCheckpoint(memory, undefined, key, options.memoryConfig ?? DEFAULT_CONFIG.memory);
        await embedNewRows(memory, options.memoryConfig ?? DEFAULT_CONFIG.memory);
      }
    } finally {
      memory.close();
    }
    return {
      status: "ingested",
      path: file.path,
      sessionKey: key,
      projectId: project.id,
      messages: chunk.messages.length,
      usage: chunk.usage.length,
      events: chunk.events.length,
    };
  } finally {
    global.close();
  }
}

async function walk(root: string, accept: (path: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "subagents") return;
          await visit(path);
        } else if (entry.isFile() && accept(path)) {
          files.push(path);
        }
      }),
    );
  }
  await visit(root);
  return files;
}

export async function listTranscripts(homes: AgentHome[]): Promise<TranscriptFile[]> {
  const lists = await Promise.all(
    homes.map(async (home) => {
      const root = join(home.dir, home.agent === "codex" ? "sessions" : "projects");
      const accept =
        home.agent === "cursor"
          ? (path: string) => path.endsWith(".jsonl") && path.includes("agent-transcripts")
          : (path: string) => path.endsWith(".jsonl");
      return (await walk(root, accept)).map((path) => ({ agent: home.agent, path, sourceDir: home.dir }));
    }),
  );
  return lists.flat();
}

export interface SyncOptions {
  /** Only transcripts modified at or after this time. */
  since?: Date;
  /** Restrict to the project this directory belongs to (default: every project). */
  cwd?: string;
  memoryConfig?: MemoryConfig;
  extraDirs?: string[];
}

export interface SyncSummary {
  scanned: number;
  ingested: number;
  unchanged: number;
  skipped: number;
  messages: number;
  projects: string[];
}

export async function syncTranscripts(options: SyncOptions = {}): Promise<SyncSummary> {
  const files = await listTranscripts(discoverHomes({ ...(options.extraDirs ? { extraDirs: options.extraDirs } : {}) }));
  const onlyProjectId = options.cwd ? resolveProject(options.cwd).id : undefined;
  const summary: SyncSummary = { scanned: 0, ingested: 0, unchanged: 0, skipped: 0, messages: 0, projects: [] };
  const projects = new Set<string>();
  for (const file of files) {
    if (options.since) {
      try {
        if ((await stat(file.path)).mtime < options.since) continue;
      } catch {
        continue;
      }
    }
    summary.scanned += 1;
    const result = await ingestTranscript(file, {
      ...(options.memoryConfig ? { memoryConfig: options.memoryConfig } : {}),
      ...(onlyProjectId ? { onlyProjectId } : {}),
    });
    summary[result.status] += 1;
    summary.messages += result.messages;
    if (result.status === "ingested" && result.projectId) projects.add(result.projectId);
  }
  summary.projects = [...projects];
  return summary;
}
