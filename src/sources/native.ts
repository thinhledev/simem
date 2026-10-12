import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "../memory/db.js";
import { contentHash, upsertMemoryItem } from "../memory/items.js";
import { sanitizeText } from "../memory/sanitize.js";
import { capText, oneLine } from "../memory/text-cap.js";
import type { MemoryCategory } from "../memory/types.js";
import { openGlobalDb } from "../store/global-db.js";
import { resolveProject } from "../store/project.js";
import { loadSqliteSync } from "../store/sqlite.js";
import { homesFor } from "./homes.js";
import { sessionKey } from "./ingest.js";

// Imports memory the agents already keep for themselves, so it survives a
// switch of account or agent: Claude Code's auto-memory files (per config dir
// and per path, so every account and worktree contributes), the Claude app's
// per-session title and status line, and Codex's memories database.

export interface NativeImportSummary {
  autoMemoryItems: number;
  globalItems: number;
  appSummaries: number;
  codexSummaries: number;
}

function slugFor(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

interface AutoMemoryFile {
  name?: string;
  description?: string;
  type?: string;
  body: string;
}

export function parseAutoMemory(raw: string): AutoMemoryFile {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match) return { body: raw.trim() };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv?.[1] && kv[2] !== undefined && kv[2].trim()) fields[kv[1]] ??= kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    ...(fields.type ? { type: fields.type } : {}),
    body: (match[2] ?? "").trim(),
  };
}

const AUTO_MEMORY_CATEGORY: Record<string, MemoryCategory> = {
  feedback: "preference",
  user: "preference",
  project: "fact",
  reference: "fact",
};

function autoMemoryText(file: AutoMemoryFile): string {
  const firstParagraph = file.body.split(/\n\s*\n/)[0] ?? "";
  const text = [file.description, oneLine(firstParagraph)].filter(Boolean).join(" — ");
  return capText(sanitizeText(text), 400).text;
}

// True only when the item is new; a known item is just reinforced.
function upsertGlobalItem(db: DatabaseSync, text: string, category: MemoryCategory, projectId: string): boolean {
  const now = new Date().toISOString();
  const existed = db.prepare("SELECT 1 FROM global_items WHERE content_hash = ?").get(contentHash(text));
  db
    .prepare(
      `INSERT INTO global_items (category, text, importance, content_hash, origin, source_project_id, created_at, last_reinforced_at)
       VALUES (?, ?, 7, ?, 'import', ?, ?, ?)
       ON CONFLICT(content_hash) DO UPDATE SET last_reinforced_at = excluded.last_reinforced_at`,
    )
    .run(category, text, contentHash(text), projectId, now, now);
  return !existed;
}

async function importAutoMemory(cwd: string, summary: NativeImportSummary): Promise<void> {
  const project = resolveProject(cwd);
  const paths = new Set<string>([project.root, resolve(cwd)]);
  const global = openGlobalDb();
  try {
    if (global) {
      const rows = global.prepare("SELECT path FROM project_paths WHERE project_id = ?").all(project.id) as Array<{ path: string }>;
      for (const row of rows) paths.add(row.path);
    }
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return;
    try {
      for (const home of homesFor("claude")) {
        for (const path of paths) {
          const dir = join(home.dir, "projects", slugFor(path), "memory");
          let names: string[];
          try {
            names = (await readdir(dir)).filter((name) => name.endsWith(".md") && name !== "MEMORY.md");
          } catch {
            continue;
          }
          for (const name of names) {
            const file = parseAutoMemory(await readFile(join(dir, name), "utf8"));
            const text = autoMemoryText(file);
            if (!text) continue;
            const category = AUTO_MEMORY_CATEGORY[file.type ?? ""] ?? "fact";
            // "user" memories describe the person, not the project: they
            // belong to every project.
            if (file.type === "user" && global) {
              if (upsertGlobalItem(global, text, category, project.id)) summary.globalItems += 1;
              continue;
            }
            const result = upsertMemoryItem(memory, { kind: "semantic", category, text, importance: 7, origin: "import" });
            if (!result.reinforced) summary.autoMemoryItems += 1;
          }
        }
      }
    } finally {
      memory.close();
    }
  } finally {
    global?.close();
  }
}

function claudeDesktopRoot(): string | undefined {
  if (process.env.CLAUDE_DESKTOP_DATA_DIR) return process.env.CLAUDE_DESKTOP_DATA_DIR;
  if (process.env.MIXAI_HOME_DISCOVERY === "env") return undefined;
  if (process.platform !== "darwin") return undefined;
  return join(homedir(), "Library", "Application Support", "Claude");
}

async function walkJson(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".json")) files.push(path);
    }
  }
  await visit(root);
  return files;
}

async function importClaudeAppSummaries(cwd: string, summary: NativeImportSummary): Promise<void> {
  const root = claudeDesktopRoot();
  if (!root) return;
  const project = resolveProject(cwd);
  const memory = await openMemoryDb(cwd, { quiet: true });
  if (!memory) return;
  try {
    const update = memory.db.prepare(
      `UPDATE sessions SET title = COALESCE(?, title), app_summary = ?
       WHERE id = ? AND (app_summary IS NOT ? OR title IS NOT COALESCE(?, title))`,
    );
    const markPending = memory.db.prepare("UPDATE checkpoints SET consolidation_status = 'pending' WHERE id = ?");
    for (const path of await walkJson(join(root, "claude-code-sessions"))) {
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const sessionCwd = typeof value.originCwd === "string" ? value.originCwd : typeof value.cwd === "string" ? value.cwd : undefined;
      if (typeof value.cliSessionId !== "string" || !sessionCwd) continue;
      if (resolveProject(sessionCwd).id !== project.id) continue;
      const title = typeof value.title === "string" ? value.title : null;
      const turn = value.postTurnSummary as { status_detail?: unknown; needs_action?: unknown } | undefined;
      const detail = typeof turn?.status_detail === "string" ? turn.status_detail : "";
      const needs = typeof turn?.needs_action === "string" && turn.needs_action ? ` Needs: ${turn.needs_action}` : "";
      const appSummary = detail ? sanitizeText(`${detail}${needs}`) : null;
      const key = sessionKey("claude", value.cliSessionId);
      const result = update.run(title, appSummary, key, appSummary, title);
      if (Number(result.changes) > 0) {
        markPending.run(key);
        summary.appSummaries += 1;
      }
    }
  } finally {
    memory.close();
  }
}

// Codex's own memory store (`memories_<n>.sqlite`) has an undocumented
// schema, so it is opened read-only and only used when the expected table
// and columns are present.
async function importCodexMemories(summary: NativeImportSummary): Promise<void> {
  const sqlite = loadSqliteSync();
  const global = openGlobalDb();
  if (!sqlite || !global) return;
  try {
    for (const home of homesFor("codex")) {
      let names: string[];
      try {
        names = (await readdir(home.dir)).filter((name) => /^memories(_\d+)?\.sqlite$/.test(name));
      } catch {
        continue;
      }
      for (const name of names) {
        let db: DatabaseSync;
        try {
          db = new sqlite.DatabaseSync(join(home.dir, name), { readOnly: true });
        } catch {
          continue;
        }
        try {
          const columns = new Set((db.prepare("PRAGMA table_info(stage1_outputs)").all() as Array<{ name: string }>).map((c) => c.name));
          if (!["thread_id", "raw_memory", "rollout_summary"].every((column) => columns.has(column))) continue;
          const rows = db.prepare("SELECT thread_id, raw_memory, rollout_summary FROM stage1_outputs").all() as Array<{
            thread_id: string;
            raw_memory: string;
            rollout_summary: string;
          }>;
          for (const row of rows) {
            const cursor = global
              .prepare("SELECT cwd FROM ingest_cursors WHERE agent = 'codex' AND session_id = ? AND cwd IS NOT NULL LIMIT 1")
              .get(row.thread_id) as { cwd: string } | undefined;
            if (!cursor) continue;
            const memory = await openMemoryDb(cursor.cwd, { quiet: true });
            if (!memory) continue;
            try {
              const key = sessionKey("codex", row.thread_id);
              const appSummary = capText(sanitizeText(oneLine(row.rollout_summary ?? "")), 600).text || null;
              const result = memory.db
                .prepare("UPDATE sessions SET app_summary = ? WHERE id = ? AND app_summary IS NOT ?")
                .run(appSummary, key, appSummary);
              if (Number(result.changes) > 0) {
                memory.db.prepare("UPDATE checkpoints SET consolidation_status = 'pending' WHERE id = ?").run(key);
                summary.codexSummaries += 1;
              }
              for (const line of (row.raw_memory ?? "").split("\n")) {
                const text = sanitizeText(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim());
                if (text.length < 20 || text.length > 400) continue;
                upsertMemoryItem(memory, { kind: "semantic", category: "fact", text, importance: 6, origin: "import", sourceCheckpointId: null });
              }
            } finally {
              memory.close();
            }
          }
        } catch {
          // Schema drift: skip this file rather than fail the import.
        } finally {
          db.close();
        }
      }
    }
  } finally {
    global.close();
  }
}

// Best-effort: each source fails soft, so one unreadable file never stops the rest.
export async function importNativeMemory(cwd: string): Promise<NativeImportSummary> {
  const summary: NativeImportSummary = { autoMemoryItems: 0, globalItems: 0, appSummaries: 0, codexSummaries: 0 };
  for (const step of [() => importAutoMemory(cwd, summary), () => importClaudeAppSummaries(cwd, summary), () => importCodexMemories(summary)]) {
    try {
      await step();
    } catch {
      // Keep going with the other sources.
    }
  }
  return summary;
}

export interface GlobalItem {
  id: number;
  category: string | null;
  text: string;
  importance: number;
}

export function listGlobalItems(limit = 50): GlobalItem[] {
  const db = openGlobalDb();
  if (!db) return [];
  try {
    return db
      .prepare("SELECT id, category, text, importance FROM global_items ORDER BY importance DESC, last_reinforced_at DESC LIMIT ?")
      .all(limit) as unknown as GlobalItem[];
  } finally {
    db.close();
  }
}

// promote: copy a project item into the user-wide store; demote: remove it.
export function promoteToGlobal(text: string, category: string | null, importance: number, projectId: string): number {
  const db = openGlobalDb();
  if (!db) throw new Error("Global memory requires node:sqlite (Node.js >= 22.5)");
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO global_items (category, text, importance, content_hash, origin, source_project_id, created_at, last_reinforced_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?)
       ON CONFLICT(content_hash) DO UPDATE SET importance = MAX(importance, excluded.importance), last_reinforced_at = excluded.last_reinforced_at`,
    ).run(category, text, importance, contentHash(text), projectId, now, now);
    const row = db.prepare("SELECT id FROM global_items WHERE content_hash = ?").get(contentHash(text)) as { id: number };
    return row.id;
  } finally {
    db.close();
  }
}

export function demoteGlobal(id: number): boolean {
  const db = openGlobalDb();
  if (!db) return false;
  try {
    return Number(db.prepare("DELETE FROM global_items WHERE id = ?").run(id).changes) > 0;
  } finally {
    db.close();
  }
}
