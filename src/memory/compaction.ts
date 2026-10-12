import type { MemoryConfig } from "../config.js";
import type { MemoryDb } from "./db.js";
import { runDistill, type DistillRunner } from "./distill/runner.js";
import { recordSavings } from "./savings.js";
import { capText, oneLine } from "./text-cap.js";

export interface CompactionResult {
  epochDigests: number;
  projectDigests: number;
  detail?: string;
}

export interface SummaryRow {
  id: number;
  text: string;
  covers_from: string;
  covers_to: string;
  checkpoint_count: number;
  milestone: number;
}

// Byte-identical across every rollup call — the only part of this prompt
// that could ever benefit from a provider-side prefix cache. In practice it
// doesn't today: each rollup is a fresh one-shot CLI invocation with no
// session reuse (see the Phase 3 session-reuse analysis), so this buys
// determinism/diff-friendliness, not a measured cost reduction.
const STABLE_ROLLUP_INSTRUCTION =
  "You are compacting the long-term memory of a coding project. Merge the following summaries into ONE digest. " +
  "Preserve concrete decisions, constraints, key outcomes, and unresolved threads; drop routine detail and " +
  "pleasantries. Write plain prose, chronological, self-contained. Respond with only the digest text.";

interface RollupPromptResult {
  prompt: string;
  /** Raw, uncapped length of every input summary's text (rollup-cap "full" side). */
  charsFull: number;
  /** Length of the (possibly capText-truncated) text actually placed in the prompt. */
  charsCapped: number;
}

// memory_items are deliberately untouched by this whole module: only episodic
// *summaries* roll up. Durable facts never expire — that is the contract.
function rollupPrompt(
  kind: "epoch" | "project",
  summaries: SummaryRow[],
  constraints: string[],
  summaryCharCap: number,
): RollupPromptResult {
  const wordCap = kind === "epoch" ? 250 : 300;
  const label = kind === "epoch" ? "chronological checkpoint summaries" : "epoch digests";
  const hasMilestones = summaries.some((summary) => summary.milestone);
  const variableClause = `(Merging ${summaries.length} ${label}; target length: at most ${wordCap} words.)`;
  const milestoneClause = hasMilestones
    ? "\nEntries marked [MILESTONE] completed a distinct, nameable objective — weight them more heavily than routine entries and keep their outcome legible in the digest.\n"
    : "";
  let charsFull = 0;
  let charsCapped = 0;
  const body = summaries
    .map((summary, index) => {
      const { text } = capText(summary.text, summaryCharCap);
      charsFull += summary.text.length;
      charsCapped += text.length;
      const prefix = summary.milestone ? "[MILESTONE] " : "";
      return `--- ${index + 1} (${summary.covers_from} … ${summary.covers_to}) ---\n${prefix}${text}`;
    })
    .join("\n\n");
  const prompt = `${STABLE_ROLLUP_INSTRUCTION}
${variableClause}
${constraints.length ? `\nNever drop these standing constraints (restate briefly if relevant):\n${constraints.map((text) => `- ${text}`).join("\n")}\n` : ""}${milestoneClause}
${body}`;
  return { prompt, charsFull, charsCapped };
}

function verbatimWindowIds(memory: MemoryDb, count: number): Set<string> {
  const rows = memory.db
    .prepare("SELECT id FROM checkpoints ORDER BY created_at DESC LIMIT ?")
    .all(count) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function activeLevelSummaries(memory: MemoryDb, level: number): SummaryRow[] {
  return memory.db
    .prepare(
      `SELECT s.id, s.text, s.covers_from, s.covers_to, s.checkpoint_count, s.milestone
       FROM summaries s
       LEFT JOIN checkpoints c ON c.id = s.covers_from
       WHERE s.level = ? AND s.superseded_by IS NULL
       ORDER BY COALESCE(c.created_at, s.created_at)`,
    )
    .all(level) as unknown as SummaryRow[];
}

function highImportanceConstraints(memory: MemoryDb, checkpointIds: string[]): string[] {
  if (checkpointIds.length === 0) return [];
  const placeholders = checkpointIds.map(() => "?").join(", ");
  const rows = memory.db
    .prepare(
      `SELECT text FROM memory_items
       WHERE kind = 'semantic' AND importance >= 8 AND status = 'active'
         AND source_checkpoint_id IN (${placeholders})
       ORDER BY importance DESC LIMIT 12`,
    )
    .all(...checkpointIds) as Array<{ text: string }>;
  return rows.map((row) => row.text);
}

// Zero-token rollup: one line per merged summary (milestones flagged), plus the
// standing constraints, capped to the same budget an LLM digest gets. Less
// fluent than prose, but nothing is invented and nothing is spent.
export function extractiveDigest(
  kind: "epoch" | "project",
  summaries: SummaryRow[],
  constraints: string[],
  summaryCharCap: number,
): string {
  const wordCap = kind === "epoch" ? 250 : 300;
  const perLine = Math.max(80, Math.min(summaryCharCap, Math.floor((wordCap * 7) / Math.max(1, summaries.length))));
  const lines = summaries.map((summary) => {
    const text = capText(oneLine(summary.text), perLine).text;
    return `- ${summary.milestone ? "[MILESTONE] " : ""}${text}`;
  });
  const standing = constraints.length ? `\nStanding constraints:\n${constraints.map((text) => `- ${text}`).join("\n")}` : "";
  return capText(`${lines.join("\n")}${standing}`, wordCap * 8).text;
}

async function rollup(
  memory: MemoryDb,
  runner: DistillRunner | undefined,
  config: MemoryConfig,
  kind: "epoch" | "project",
  batch: SummaryRow[],
  targetLevel: number,
): Promise<boolean> {
  const first = batch[0];
  const last = batch.at(-1);
  if (!first || !last) return false;
  const constraints = kind === "epoch" ? highImportanceConstraints(memory, batch.map((row) => row.covers_from)) : [];
  let text: string | undefined;
  if (runner) {
    const { prompt, charsFull, charsCapped } = rollupPrompt(kind, batch, constraints, config.rollupSummaryCharCap);
    const call = await runDistill(memory, runner, {
      purpose: kind === "epoch" ? "rollup-epoch" : "rollup-project",
      prompt,
      cwd: process.cwd(),
      timeoutMs: config.consolidationTimeoutMs,
    });
    // What the per-summary character cap kept out of the LLM prompt this call.
    recordSavings(memory, { mechanism: "rollup-cap", charsFull, charsSent: charsCapped });
    text = call.output?.trim();
  }
  // No LLM tier, or it failed: fall back to the extractive digest so
  // compaction never stalls waiting for a provider.
  text ||= extractiveDigest(kind, batch, constraints, config.rollupSummaryCharCap);
  const checkpointCount = batch.reduce((sum, row) => sum + row.checkpoint_count, 0);
  const inserted = memory.db
    .prepare(
      "INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(targetLevel, text, first.covers_from, last.covers_to, checkpointCount, new Date().toISOString());
  const digestId = Number(inserted.lastInsertRowid);
  const mark = memory.db.prepare("UPDATE summaries SET superseded_by = ? WHERE id = ?");
  for (const row of batch) mark.run(digestId, row.id);
  // What no longer needs to be individually kept now that these summaries
  // are folded into one digest — the raw, uncapped text lengths, since
  // without compaction each would remain an active summary forever.
  recordSavings(memory, {
    mechanism: "compaction",
    charsFull: batch.reduce((sum, row) => sum + row.text.length, 0),
    charsSent: text.length,
  });
  return true;
}

// Recursive rollup: L1 per-checkpoint summaries outside the verbatim window
// fold into L2 epoch digests, epochs fold into a single L3 project digest.
// Superseded summaries are kept (searchable with a flag), never deleted.
export async function runCompaction(
  memory: MemoryDb,
  runner: DistillRunner | undefined,
  config: MemoryConfig,
): Promise<CompactionResult> {
  const result: CompactionResult = { epochDigests: 0, projectDigests: 0 };
  const verbatim = verbatimWindowIds(memory, config.verbatimCheckpoints);

  for (;;) {
    const eligible = activeLevelSummaries(memory, 1).filter((row) => !verbatim.has(row.covers_from));
    if (eligible.length < config.epochSize) break;
    const ok = await rollup(memory, runner, config, "epoch", eligible.slice(0, config.epochSize), 2);
    if (!ok) {
      result.detail = "epoch rollup unavailable; will retry on the next compact";
      return result;
    }
    result.epochDigests += 1;
  }

  const epochs = activeLevelSummaries(memory, 2);
  if (epochs.length >= config.projectDigestEpochs) {
    // Fold the previous project digest in so nothing already distilled is lost.
    const previous = activeLevelSummaries(memory, 3);
    const ok = await rollup(memory, runner, config, "project", [...previous, ...epochs], 3);
    if (!ok) {
      result.detail = "project rollup unavailable; will retry on the next compact";
      return result;
    }
    result.projectDigests += 1;
  }
  return result;
}
