import type { MemoryConfig } from "../config.js";
import type { MemoryDb } from "./db.js";
import { openMemoryDb } from "./db.js";
import { distillWithRules } from "./distill/rules.js";
import { runDistill, type DistillRunner } from "./distill/runner.js";
import { upsertMemoryItem, type MemoryOrigin } from "./items.js";
import { recordSavings } from "./savings.js";
import {
  MEMORY_CATEGORIES,
  MEMORY_KINDS,
  type ConsolidationItem,
  type ConsolidationOutput,
  type ConsolidationResult,
} from "./types.js";

export type { ConsolidationRunner, DistillRunner } from "./distill/runner.js";

interface ActiveItemRow {
  id: number;
  kind: string;
  category: string | null;
  text: string;
  importance: number;
}

interface ActiveItems {
  items: ActiveItemRow[];
  totalCount: number;
  /** Total character length of every active item's text, included or not — the "full" side of the consolidation-cap saving. */
  totalChars: number;
}

// Ordered importance-first: when the cap truncates, the highest-value
// standing facts stay in the prompt and only the least important ones are
// dropped (and pointed at via memory_search). This ordering has no bearing
// on provider-side prompt caching — each consolidation call is a fresh
// one-shot CLI invocation, so there is no cross-call prefix to preserve.
function activeItems(memory: MemoryDb, limit: number): ActiveItems {
  const items = memory.db
    .prepare(
      "SELECT id, kind, category, text, importance FROM memory_items WHERE status = 'active' ORDER BY importance DESC, id LIMIT ?",
    )
    .all(limit) as unknown as ActiveItemRow[];
  const totals = memory.db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)), 0) AS chars FROM memory_items WHERE status = 'active'")
    .get() as { n: number; chars: number };
  return { items, totalCount: totals.n, totalChars: totals.chars };
}

export function buildConsolidationPrompt(input: {
  checkpointId: string;
  createdAt: string;
  existingItems: ActiveItemRow[];
  totalExistingItems?: number;
  messages: Array<{ role: string; text: string }>;
  capChars: number;
}): string {
  const omitted = (input.totalExistingItems ?? input.existingItems.length) - input.existingItems.length;
  const existing = input.existingItems.length
    ? input.existingItems
        .map((item) => `${item.id}. [${item.kind}${item.category ? `/${item.category}` : ""}, importance ${item.importance}] ${item.text}`)
        .join("\n") + (omitted > 0 ? `\n(+${omitted} older lower-importance items omitted; use memory_search to find them)` : "")
    : "(none)";
  // Keep the newest messages; they matter most for extracting new facts.
  const parts: string[] = [];
  let used = 0;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (!message) continue;
    const block = `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`;
    if (used + block.length > input.capChars && parts.length > 0) break;
    parts.unshift(block.length > input.capChars ? `${block.slice(0, input.capChars)}…` : block);
    used += block.length;
  }
  return `You are updating a persistent project memory store for a coding-agent handoff system.
Respond with ONLY a JSON object (no prose, no markdown fences) of this exact shape:

{
  "summary": "<80-160 word summary of what happened in this checkpoint>",
  "milestone": <true | false>,
  "items": [
    {
      "kind": "semantic" | "episodic" | "procedural",
      "category": "decision" | "constraint" | "preference" | "fact" | "todo" | null,
      "text": "<one self-contained sentence, no pronouns without antecedents>",
      "importance": <integer 1-10>,
      "supersedes": <integer id from EXISTING ITEMS, or null>
    }
  ]
}

Rules:
- Extract only NEW information not already covered by EXISTING ITEMS.
- importance 8-10: hard constraints, explicit user decisions or preferences, irreversible actions.
- importance 4-7: useful project facts and notable events.
- importance 1-3: routine detail — omit such items entirely.
- Set "supersedes" when a new item corrects or replaces an existing one; never duplicate.
- If nothing new and important happened, return "items": [].
- Set "milestone": true only if this checkpoint completed a distinct, nameable objective (e.g. "shipped X", "fixed Y bug") — not routine or partial progress. Otherwise false.

EXISTING ITEMS (active):
${existing}

LATEST CHECKPOINT (${input.checkpointId}, ${input.createdAt}):
${parts.join("\n\n")}`;
}

function asConsolidationItem(value: unknown, existingIds: Set<number>): ConsolidationItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string" || !record.text.trim()) return undefined;
  if (!MEMORY_KINDS.includes(record.kind as (typeof MEMORY_KINDS)[number])) return undefined;
  const importance = Number(record.importance);
  if (!Number.isInteger(importance) || importance < 1 || importance > 10) return undefined;
  const category = MEMORY_CATEGORIES.includes(record.category as (typeof MEMORY_CATEGORIES)[number])
    ? (record.category as (typeof MEMORY_CATEGORIES)[number])
    : undefined;
  const supersedes =
    typeof record.supersedes === "number" && existingIds.has(record.supersedes)
      ? record.supersedes
      : undefined;
  return {
    kind: record.kind as ConsolidationItem["kind"],
    ...(category ? { category } : {}),
    text: record.text.trim(),
    importance,
    ...(supersedes !== undefined ? { supersedes } : {}),
  };
}

export function parseConsolidationOutput(raw: string, existingIds: Set<number>): ConsolidationOutput | undefined {
  const candidates = [raw.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.summary !== "string" || !Array.isArray(record.items)) continue;
      const items = record.items
        .map((item) => asConsolidationItem(item, existingIds))
        .filter((item): item is ConsolidationItem => Boolean(item));
      const milestone = record.milestone === true;
      return { summary: record.summary.trim(), items, milestone };
    } catch {
      // Try the next extraction strategy.
    }
  }
  return undefined;
}

function queueCheckpoint(memory: MemoryDb, checkpointId: string, error: string): void {
  memory.db
    .prepare(
      `INSERT INTO consolidation_queue (checkpoint_id, queued_at, attempts, last_error)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(checkpoint_id) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error`,
    )
    .run(checkpointId, new Date().toISOString(), error);
}

function setStatus(memory: MemoryDb, checkpointId: string, status: "rules" | "done"): void {
  memory.db.prepare("UPDATE checkpoints SET consolidation_status = ? WHERE id = ?").run(status, checkpointId);
  if (status === "done") memory.db.prepare("DELETE FROM consolidation_queue WHERE checkpoint_id = ?").run(checkpointId);
}

interface WriteCounts {
  written: number;
  reinforced: number;
}

// Items are dated by their checkpoint, not by when distillation ran: a backfill
// over July checkpoints must not make July's facts look fresh to recency scoring.
function writeItems(
  memory: MemoryDb,
  checkpointId: string,
  statedAt: string,
  items: ConsolidationItem[],
  origin: MemoryOrigin,
): WriteCounts {
  const counts: WriteCounts = { written: 0, reinforced: 0 };
  for (const item of items) {
    const result = upsertMemoryItem(memory, { ...item, origin, sourceCheckpointId: checkpointId }, statedAt);
    if (result.reinforced) counts.reinforced += 1;
    else counts.written += 1;
  }
  return counts;
}

// One level-1 summary per checkpoint: a later tier's summary replaces an
// earlier one (the LLM's prose over the rules template).
function writeSummary(memory: MemoryDb, checkpointId: string, createdAt: string, output: ConsolidationOutput): void {
  memory.db
    .prepare("DELETE FROM summaries WHERE level = 1 AND covers_from = ? AND covers_to = ?")
    .run(checkpointId, checkpointId);
  memory.db
    .prepare(
      "INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at, milestone) VALUES (1, ?, ?, ?, 1, ?, ?)",
    )
    .run(output.summary, checkpointId, checkpointId, createdAt, output.milestone ? 1 : 0);
}

// Tier 0.5: the agent app's own session title and status line (Claude app
// metadata, Codex memories), captured at ingest, lead the rules summary.
function withAppSummary(memory: MemoryDb, checkpointId: string, output: ConsolidationOutput): ConsolidationOutput {
  let row: { title: string | null; app_summary: string | null } | undefined;
  try {
    row = memory.db.prepare("SELECT title, app_summary FROM sessions WHERE id = ?").get(checkpointId) as typeof row;
  } catch {
    return output;
  }
  if (!row?.title && !row?.app_summary) return output;
  const lead = [row.title ? `Title: ${row.title}` : "", row.app_summary ? `App summary: ${row.app_summary}` : ""].filter(Boolean);
  return { ...output, summary: `${lead.join("\n")}\n${output.summary}` };
}

// Tiered distillation of one checkpoint:
//   1. Rules (always, zero tokens) write items and a template summary, and
//      the checkpoint is marked "rules" (or "done" when no LLM tier is set).
//   2. The optional LLM tier (local Ollama, or opt-in remote agent) sees the
//      rule items as EXISTING ITEMS, so it adds only what rules missed and can
//      supersede them. Its failure queues the checkpoint for another LLM try;
//      the rule output is already saved, so nothing is lost meanwhile.
export async function consolidateCheckpoint(
  memory: MemoryDb,
  runner: DistillRunner | undefined,
  checkpointId: string,
  config: MemoryConfig,
): Promise<ConsolidationResult> {
  const checkpoint = memory.db
    .prepare("SELECT id, created_at, workspace, consolidation_status FROM checkpoints WHERE id = ?")
    .get(checkpointId) as
    | { id: string; created_at: string; workspace: string; consolidation_status: string }
    | undefined;
  if (!checkpoint) return { status: "skipped", checkpointId, itemsWritten: 0, detail: "not indexed" };
  if (checkpoint.consolidation_status === "done") {
    return { status: "done", checkpointId, itemsWritten: 0, detail: "already consolidated" };
  }
  const messages = memory.db
    .prepare("SELECT role, text FROM messages WHERE checkpoint_id = ? ORDER BY seq")
    .all(checkpointId) as Array<{ role: string; text: string }>;

  const counts: WriteCounts = { written: 0, reinforced: 0 };
  if (checkpoint.consolidation_status !== "rules") {
    const rules = withAppSummary(memory, checkpointId, distillWithRules(messages));
    writeSummary(memory, checkpointId, checkpoint.created_at, rules);
    const ruleCounts = writeItems(memory, checkpointId, checkpoint.created_at, rules.items, "rule");
    counts.written += ruleCounts.written;
    counts.reinforced += ruleCounts.reinforced;
    setStatus(memory, checkpointId, runner ? "rules" : "done");
  }
  const result = (status: ConsolidationResult["status"], detail?: string): ConsolidationResult => ({
    status,
    checkpointId,
    itemsWritten: counts.written,
    ...(counts.reinforced > 0 ? { itemsReinforced: counts.reinforced } : {}),
    ...(detail ? { detail } : {}),
  });
  if (!runner) {
    setStatus(memory, checkpointId, "done");
    return result("done", "rules");
  }

  const existing = activeItems(memory, config.consolidationExistingItemsLimit);
  const existingIds = new Set(existing.items.map((item) => item.id));
  const prompt = buildConsolidationPrompt({
    checkpointId,
    createdAt: checkpoint.created_at,
    existingItems: existing.items,
    totalExistingItems: existing.totalCount,
    messages,
    capChars: config.consolidationTokenCapChars,
  });
  // What the existing-items cap kept out of this prompt: all active items'
  // text vs just the ones actually included.
  recordSavings(memory, {
    mechanism: "consolidation-cap",
    charsFull: existing.totalChars,
    charsSent: existing.items.reduce((sum, item) => sum + item.text.length, 0),
  });

  let call;
  try {
    call = await runDistill(memory, runner, {
      purpose: "consolidate",
      checkpointId,
      prompt,
      cwd: checkpoint.workspace,
      timeoutMs: config.consolidationTimeoutMs,
    });
  } catch (error) {
    call = { detail: error instanceof Error ? error.message : String(error) };
  }
  if (!call.output) {
    const detail = call.detail ?? "no output";
    queueCheckpoint(memory, checkpointId, detail);
    return result("queued", detail);
  }
  const output = parseConsolidationOutput(call.output, existingIds);
  if (!output) {
    queueCheckpoint(memory, checkpointId, "unparseable consolidation output");
    return result("queued", "unparseable consolidation output");
  }
  writeSummary(memory, checkpointId, checkpoint.created_at, output);
  const llmCounts = writeItems(memory, checkpointId, checkpoint.created_at, output.items, "llm");
  counts.written += llmCounts.written;
  counts.reinforced += llmCounts.reinforced;
  setStatus(memory, checkpointId, "done");
  return result("done");
}

// Retries queued checkpoints. With no LLM tier configured (any more), queued
// checkpoints simply finish on the rules tier instead of waiting forever.
export async function drainConsolidationQueue(
  memory: MemoryDb,
  runner: DistillRunner | undefined,
  config: MemoryConfig,
): Promise<ConsolidationResult[]> {
  const queued = memory.db
    .prepare("SELECT checkpoint_id FROM consolidation_queue ORDER BY queued_at LIMIT ?")
    .all(config.queueDrainLimit) as Array<{ checkpoint_id: string }>;
  const results: ConsolidationResult[] = [];
  for (const entry of queued) {
    const result = await consolidateCheckpoint(memory, runner, entry.checkpoint_id, config);
    results.push(result);
    // A queued retry that fails again means the provider is still unavailable;
    // stop early instead of paying the same failure for every queued row.
    if (result.status === "queued") break;
  }
  return results;
}

export interface DistillAllResult {
  checkpoints: number;
  itemsWritten: number;
  itemsReinforced: number;
}

// Backfill: runs the rules tier over checkpoints that never got it — those
// still pending, and with `all`, also ones an LLM already consolidated
// (items only: their LLM summary is kept). Re-running is safe; restated
// items reinforce instead of duplicating.
export function distillWithRulesBackfill(memory: MemoryDb, options: { all?: boolean } = {}): DistillAllResult {
  const statuses = options.all ? ["pending", "rules", "done", "skipped"] : ["pending"];
  const rows = memory.db
    .prepare(
      `SELECT id, created_at, consolidation_status FROM checkpoints
       WHERE consolidation_status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at`,
    )
    .all(...statuses) as Array<{ id: string; created_at: string; consolidation_status: string }>;
  const totals: DistillAllResult = { checkpoints: 0, itemsWritten: 0, itemsReinforced: 0 };
  const selectMessages = memory.db.prepare("SELECT role, text FROM messages WHERE checkpoint_id = ? ORDER BY seq");
  for (const row of rows) {
    const messages = selectMessages.all(row.id) as Array<{ role: string; text: string }>;
    const rules = distillWithRules(messages);
    if (row.consolidation_status === "pending") {
      writeSummary(memory, row.id, row.created_at, rules);
      setStatus(memory, row.id, "done");
    }
    const counts = writeItems(memory, row.id, row.created_at, rules.items, "rule");
    totals.checkpoints += 1;
    totals.itemsWritten += counts.written;
    totals.itemsReinforced += counts.reinforced;
  }
  return totals;
}

// Best-effort entry point for the switch/export/hook paths: drains a few
// queued checkpoints, distills the new one, and never throws. The token-free
// checkpoint write has already completed before this runs.
export async function consolidateBestEffort(
  cwd: string,
  runner: DistillRunner | undefined,
  checkpointId: string,
  config: MemoryConfig,
): Promise<ConsolidationResult> {
  const fallback: ConsolidationResult = {
    status: "disabled",
    checkpointId,
    itemsWritten: 0,
  };
  if (!config.enabled) return fallback;
  try {
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return fallback;
    try {
      await drainConsolidationQueue(memory, runner, config);
      return await consolidateCheckpoint(memory, runner, checkpointId, config);
    } finally {
      memory.close();
    }
  } catch (error) {
    return { ...fallback, status: "skipped", detail: error instanceof Error ? error.message : String(error) };
  }
}
