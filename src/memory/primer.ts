import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryConfig } from "../config.js";
import { listGlobalItems } from "../sources/native.js";
import { projectStoreDir, resolveProject } from "../store/project.js";
import type { MemoryDb } from "./db.js";
import { openMemoryDb } from "./db.js";
import { recordInjections } from "./injections.js";
import { capText, oneLine } from "./text-cap.js";

// The session-start primer: what an agent would otherwise spend its first
// turns re-discovering (what this project is doing, standing decisions, how
// to build and test), in a fixed shape under a fixed budget. Deterministic and
// free of "now", so the same memory yields the same bytes and the provider's
// prompt-prefix cache keeps hitting. It also carries the latest work from
// any other agent or account — opening Codex after Claude just continues.

export interface Primer {
  text: string;
  /** Rows included ("memory_item:<id>", "summary:<id>"), so per-prompt injection doesn't repeat them. */
  refs: string[];
}

const SECTION_ITEM_CHARS = 220;

interface LatestWork {
  agent: string;
  surface: string;
  at: string;
  summary: string;
  summaryId?: number;
}

function latestWork(memory: MemoryDb, excludeSession?: string): LatestWork | undefined {
  const row = memory.db
    .prepare(
      `SELECT s.agent, s.surface, s.last_activity_at AS at, COALESCE(m.text, s.title) AS summary, m.id AS summary_id
       FROM sessions s
       LEFT JOIN summaries m ON m.covers_from = s.id AND m.level = 1
       WHERE s.message_count > 0 ${excludeSession ? "AND s.id != ?" : ""}
       ORDER BY s.last_activity_at DESC LIMIT 1`,
    )
    .get(...(excludeSession ? [excludeSession] : [])) as
    | { agent: string; surface: string; at: string; summary: string | null; summary_id: number | null }
    | undefined;
  if (row?.summary) {
    return { agent: row.agent, surface: row.surface, at: row.at, summary: row.summary, ...(row.summary_id !== null ? { summaryId: row.summary_id } : {}) };
  }
  // Fall back to the newest checkpoint summary (1.x data, handoffs).
  const checkpoint = memory.db
    .prepare(
      `SELECT c.source_provider AS agent, c.created_at AS at, s.text AS summary, s.id AS summary_id FROM summaries s
       JOIN checkpoints c ON c.id = s.covers_from WHERE s.level = 1 ORDER BY c.created_at DESC LIMIT 1`,
    )
    .get() as { agent: string; at: string; summary: string; summary_id: number } | undefined;
  return checkpoint
    ? { agent: checkpoint.agent, at: checkpoint.at, summary: checkpoint.summary, summaryId: checkpoint.summary_id, surface: "unknown" }
    : undefined;
}

function durableItems(memory: MemoryDb, limit: number): Array<{ id: number; text: string; category: string | null }> {
  return memory.db
    .prepare(
      `SELECT id, text, category FROM memory_items
       WHERE status = 'active' AND kind = 'semantic' AND importance >= 7
       ORDER BY importance DESC, last_reinforced_at DESC, id LIMIT ?`,
    )
    .all(limit) as Array<{ id: number; text: string; category: string | null }>;
}

const PROCEDURAL = /\b(test|tests|build|lint|typecheck|type-check|check|tsc|vitest|jest|pytest|cargo|make|gradle|mvn)\b/;

// Build/test commands this project's sessions actually ran successfully,
// most frequent first — procedural memory without an LLM.
export function knownCommands(memory: MemoryDb, limit = 6): string[] {
  const rows = memory.db
    .prepare(
      `SELECT target, COUNT(*) AS n FROM events
       WHERE type = 'command' AND target IS NOT NULL AND (ok = 1 OR exit_code = 0)
       GROUP BY target ORDER BY n DESC, target LIMIT 200`,
    )
    .all() as Array<{ target: string; n: number }>;
  const commands: string[] = [];
  for (const row of rows) {
    // Keep the command itself: drop a leading `cd … &&` and trailing pipes/redirections.
    const command = row.target
      .replace(/^cd\s+\S+\s*&&\s*/, "")
      .split(/\s*(?:\||2>&1|>|&&)\s*/)[0]!
      .trim();
    if (!PROCEDURAL.test(command) || command.length > 80 || commands.includes(command)) continue;
    commands.push(command);
    if (commands.length === limit) break;
  }
  return commands;
}

function bullet(text: string): string {
  return `- ${capText(oneLine(text), SECTION_ITEM_CHARS).text}`;
}

export function buildPrimer(
  memory: MemoryDb,
  project: { name: string },
  options: { maxChars: number; excludeSession?: string; layout?: string },
): Primer {
  const sections: string[] = [];
  const refs: string[] = [];
  const work = latestWork(memory, options.excludeSession);
  if (work) {
    if (work.summaryId !== undefined) refs.push(`summary:${work.summaryId}`);
    const who = `${work.agent}${work.surface === "app" ? " app" : work.surface === "cli" ? " CLI" : ""}`;
    sections.push(`### Latest work (${who}, ${work.at.slice(0, 10)})\n\n${capText(work.summary, 700).text}`);
  }
  const items = durableItems(memory, 12);
  if (items.length > 0) {
    sections.push(`### Decisions & constraints\n\n${items.map((item) => bullet(item.text)).join("\n")}`);
    refs.push(...items.map((item) => `memory_item:${item.id}`));
  }
  const preferences = listGlobalItems(5);
  if (preferences.length > 0) sections.push(`### Your preferences (all projects)\n\n${preferences.map((item) => bullet(item.text)).join("\n")}`);
  const commands = knownCommands(memory);
  if (commands.length > 0) sections.push(`### Build & test commands that worked here\n\n${commands.map((command) => `- \`${command}\``).join("\n")}`);
  if (options.layout) sections.push(`### Layout\n\n${options.layout}`);
  if (sections.length === 0) return { text: "", refs: [] };
  const footer =
    "Ask project memory before re-exploring: the `recall` tool (or `simem recall`) for past decisions, `code_search` / `code_outline` to find code without reading whole files.";
  const body = [`## Project memory: ${project.name} (simem)`, ...sections, footer].join("\n\n");
  return { text: `${capText(body, options.maxChars).text}\n`, refs };
}

// Cached by content hash: rebuilding is cheap, but the cache makes the
// "same inputs, same bytes" property explicit and observable.
export async function sessionPrimer(
  cwd: string,
  config: MemoryConfig,
  options: { sessionKey?: string; maxChars?: number; layout?: string } = {},
): Promise<string> {
  const memory = await openMemoryDb(cwd, { quiet: true });
  if (!memory) return "";
  try {
    const project = resolveProject(cwd);
    const primer = buildPrimer(memory, project, {
      maxChars: options.maxChars ?? config.hooks.briefMaxChars,
      ...(options.sessionKey ? { excludeSession: options.sessionKey } : {}),
      ...(options.layout ? { layout: options.layout } : {}),
    });
    if (!primer.text) return "";
    if (options.sessionKey) recordInjections(memory, options.sessionKey, primer.refs);
    try {
      const path = join(projectStoreDir(cwd), "primer.md");
      const hash = createHash("sha256").update(primer.text).digest("hex");
      let previous = "";
      try {
        previous = readFileSync(path, "utf8");
      } catch {
        // First primer for this project.
      }
      if (createHash("sha256").update(previous).digest("hex") !== hash) writeFileSync(path, primer.text, "utf8");
    } catch {
      // The cache file is informational.
    }
    return primer.text;
  } finally {
    memory.close();
  }
}
