import type { MemoryConfig } from "../config.js";
import { runCompaction } from "./compaction.js";
import {
  consolidateBestEffort,
  distillWithRulesBackfill,
  drainConsolidationQueue,
  type DistillRunner,
} from "./consolidate.js";
import type { MemoryDb } from "./db.js";
import { openMemoryDb } from "./db.js";
import { embedNewRows, resolveEmbeddings } from "../vec/client.js";
import { upsertMemoryItem } from "./items.js";
import { demoteGlobal, listGlobalItems, promoteToGlobal } from "../sources/native.js";
import { resolveProject } from "../store/project.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBundle, encodeBundle, exportBundle, importBundle } from "../portability/bundle.js";
import { spendSummary, spendTotals } from "./ledger.js";
import { toPreview } from "./preview.js";
import { embedMissing, reindexMemory } from "./reindex.js";
import { search } from "./retrieval.js";
import { recordSavings, savingsSummary, savingsTotals } from "./savings.js";
import { MEMORY_CATEGORIES, MEMORY_KINDS, type MemoryCategory, type MemoryKind, type MemoryStats } from "./types.js";

async function embeddingClient(memoryConfig: MemoryConfig | undefined) {
  return await resolveEmbeddings(memoryConfig);
}

export interface MemoryCommandOptions {
  cwd: string;
  json: boolean;
  args: string[];
  rebuild: boolean;
  embed: boolean;
  includeSuperseded: boolean;
  limit?: number;
  kind?: string;
  groupBy?: string;
  category?: string;
  minImportance?: number;
  since?: string;
  until?: string;
  full: boolean;
  /** Optional LLM tier for consolidation/rollups; undefined = rules only (zero provider tokens). */
  distillRunner?: DistillRunner | undefined;
  /** `memory distill --all`: also re-run rules over already-consolidated checkpoints; `memory export --all`: include transcripts. */
  all?: boolean;
  /** `memory export --path FILE` / `memory import --path FILE`. */
  path?: string;
  memoryConfig?: MemoryConfig;
}

function count(memory: MemoryDb, sql: string): number {
  const row = memory.db.prepare(sql).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export function collectStats(memory: MemoryDb): MemoryStats {
  const itemRows = memory.db
    .prepare("SELECT kind, status, COUNT(*) AS n FROM memory_items GROUP BY kind, status")
    .all() as Array<{ kind: string; status: string; n: number }>;
  const memoryItems: Record<string, number> = {};
  for (const row of itemRows) memoryItems[`${row.kind}/${row.status}`] = row.n;
  const summaryRows = memory.db
    .prepare("SELECT level, COUNT(*) AS n FROM summaries GROUP BY level")
    .all() as Array<{ level: number; n: number }>;
  const summariesByLevel: Record<string, number> = {};
  for (const row of summaryRows) summariesByLevel[`level${row.level}`] = row.n;
  return {
    dbPath: memory.path,
    checkpoints: count(memory, "SELECT COUNT(*) AS n FROM checkpoints"),
    messages: count(memory, "SELECT COUNT(*) AS n FROM messages"),
    memoryItems,
    summariesByLevel,
    queueDepth: count(memory, "SELECT COUNT(*) AS n FROM consolidation_queue"),
    fts: memory.fts,
    schemaVersion: memory.schemaVersion,
  };
}

export function showRecord(memory: MemoryDb, selector: string): unknown {
  if (/^\d+$/.test(selector)) {
    const item = memory.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(Number(selector));
    if (item) return { type: "memory_item", record: item };
    const summary = memory.db.prepare("SELECT * FROM summaries WHERE id = ?").get(Number(selector));
    if (summary) return { type: "summary", record: summary };
    return undefined;
  }
  const checkpoint = memory.db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(selector) as
    | Record<string, unknown>
    | undefined;
  if (!checkpoint) return undefined;
  const messageCount = memory.db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE checkpoint_id = ?")
    .get(selector) as { n: number };
  const summary = memory.db
    .prepare("SELECT * FROM summaries WHERE level = 1 AND covers_from = ? AND covers_to = ?")
    .get(selector, selector);
  return { type: "checkpoint", record: checkpoint, messageCount: messageCount.n, summary };
}

async function requireMemory(options: MemoryCommandOptions): Promise<MemoryDb> {
  const memory = await openMemoryDb(options.cwd);
  if (!memory) throw new Error("The memory database is unavailable on this runtime");
  return memory;
}

export async function handleMemoryCommand(
  sub: string | undefined,
  options: MemoryCommandOptions,
): Promise<void> {
  if (sub === "search") {
    const query = options.args.join(" ").trim();
    if (!query) throw new Error("memory search requires a query");
    let kind: MemoryKind | undefined;
    if (options.kind !== undefined) {
      if (!MEMORY_KINDS.includes(options.kind as MemoryKind)) {
        throw new Error(`--kind must be one of: ${MEMORY_KINDS.join(", ")}`);
      }
      kind = options.kind as MemoryKind;
    }
    let category: MemoryCategory | undefined;
    if (options.category !== undefined) {
      if (!MEMORY_CATEGORIES.includes(options.category as MemoryCategory)) {
        throw new Error(`--category must be one of: ${MEMORY_CATEGORIES.join(", ")}`);
      }
      category = options.category as MemoryCategory;
    }
    const memory = await requireMemory(options);
    try {
      const embeddings = await embeddingClient(options.memoryConfig);
      const hits = await search(memory, query, {
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(options.minImportance !== undefined ? { minImportance: options.minImportance } : {}),
        ...(options.since !== undefined ? { since: options.since } : {}),
        ...(options.until !== undefined ? { until: options.until } : {}),
        ...(embeddings ? { embeddings } : {}),
        includeSuperseded: options.includeSuperseded,
      });
      // Previews by default (matches the MCP memory_search default): agents
      // shelling out to --json pay the same reduced token cost unless they
      // opt into --full for complete text.
      if (options.full) {
        if (options.json) process.stdout.write(`${JSON.stringify(hits)}\n`);
        else if (hits.length === 0) process.stdout.write("No matches.\n");
        else {
          for (const hit of hits) {
            const origin = hit.checkpointId ? ` (${hit.checkpointId})` : "";
            process.stdout.write(
              `[${hit.score.toFixed(3)}] ${hit.source}#${hit.id}${origin}\n  ${hit.text.replaceAll("\n", "\n  ")}\n`,
            );
          }
        }
      } else {
        const previews = hits.map((hit) => toPreview(hit));
        recordSavings(memory, {
          mechanism: "disclosure",
          charsFull: hits.reduce((sum, hit) => sum + hit.text.length, 0),
          charsSent: previews.reduce((sum, preview) => sum + preview.preview.length, 0),
        });
        if (options.json) process.stdout.write(`${JSON.stringify(previews)}\n`);
        else if (previews.length === 0) process.stdout.write("No matches.\n");
        else {
          for (const preview of previews) {
            const origin = preview.checkpointId ? ` (${preview.checkpointId})` : "";
            process.stdout.write(
              `[${preview.score.toFixed(3)}] ${preview.source}#${preview.id}${origin}\n  ${preview.preview}\n`,
            );
          }
          process.stdout.write("Pass --full for complete text, or `mixai memory show <id>` to drill into one.\n");
        }
      }
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "reindex") {
    const memory = await requireMemory(options);
    try {
      const result = await reindexMemory(memory, options.cwd, { rebuild: options.rebuild });
      let embedded: { items: number; summaries: number } | undefined;
      if (options.embed) {
        const embeddings = await embeddingClient(options.memoryConfig);
        if (!embeddings) throw new Error("--embed requires a reachable Ollama with the configured embedding model");
        embedded = await embedMissing(memory, embeddings);
      }
      if (options.json) process.stdout.write(`${JSON.stringify({ ...result, embedded })}\n`);
      else {
        process.stdout.write(
          `Indexed ${result.checkpoints} checkpoints (${result.messages} messages) into ${memory.path}\n`,
        );
        for (const skipped of result.skipped) {
          process.stdout.write(`Skipped ${skipped.id}: ${skipped.reason}\n`);
        }
        if (embedded) {
          process.stdout.write(`Embedded ${embedded.items} memory item(s) and ${embedded.summaries} summary(ies)\n`);
        }
      }
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "stats") {
    const memory = await requireMemory(options);
    try {
      const stats = collectStats(memory);
      const spend = spendTotals(memory);
      const savings = savingsTotals(memory);
      if (options.json) process.stdout.write(`${JSON.stringify({ ...stats, spend, savings })}\n`);
      else {
        process.stdout.write(`Memory database: ${stats.dbPath}\n`);
        process.stdout.write(`Schema v${stats.schemaVersion}, FTS5 ${stats.fts ? "enabled" : "unavailable"}\n`);
        process.stdout.write(`Checkpoints: ${stats.checkpoints}, messages: ${stats.messages}\n`);
        process.stdout.write(`Memory items: ${JSON.stringify(stats.memoryItems)}\n`);
        process.stdout.write(`Summaries: ${JSON.stringify(stats.summariesByLevel)}\n`);
        process.stdout.write(`Consolidation queue: ${stats.queueDepth}\n`);
        process.stdout.write(
          `LLM calls: ${spend.calls} (${spend.estimatedCalls} estimated), ` +
            `${spend.inputTokens}+${spend.outputTokens} tokens, $${spend.costUsd.toFixed(4)}. Run \`mixai memory spend\` for a breakdown.\n`,
        );
        process.stdout.write(
          `Measured savings: ~${savings.estimatedTokensSaved} tokens across ${savings.events} event(s). ` +
            `Run \`mixai memory savings\` for a breakdown.\n`,
        );
      }
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "spend") {
    const groupBy = options.groupBy ?? "purpose";
    if (groupBy !== "purpose" && groupBy !== "provider" && groupBy !== "day") {
      throw new Error("--group-by must be one of: purpose, provider, day");
    }
    const memory = await requireMemory(options);
    try {
      const rows = spendSummary(memory, groupBy);
      const totals = spendTotals(memory);
      if (options.json) process.stdout.write(`${JSON.stringify({ groupBy, rows, totals })}\n`);
      else if (rows.length === 0) {
        process.stdout.write("No LLM calls recorded yet.\n");
      } else {
        for (const row of rows) {
          process.stdout.write(
            `${row.group}: ${row.calls} call(s), ${row.inputTokens}+${row.outputTokens} tokens, ` +
              `$${row.costUsd.toFixed(4)}${row.estimatedCalls ? ` (${row.estimatedCalls} estimated)` : ""}\n`,
          );
        }
        process.stdout.write(
          `Total: ${totals.calls} call(s), ${totals.inputTokens}+${totals.outputTokens} tokens, $${totals.costUsd.toFixed(4)}\n`,
        );
      }
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "savings") {
    const memory = await requireMemory(options);
    try {
      const rows = savingsSummary(memory);
      const totals = savingsTotals(memory);
      if (options.json) process.stdout.write(`${JSON.stringify({ rows, totals })}\n`);
      else if (rows.length === 0) {
        process.stdout.write(
          "No measured savings yet. Savings are recorded from whenever this feature shipped, not retroactively.\n",
        );
      } else {
        for (const row of rows) {
          process.stdout.write(
            `${row.mechanism}: ${row.events} event(s), ~${row.estimatedTokensSaved} tokens (${row.charsSaved} chars)\n`,
          );
        }
        process.stdout.write(
          `Total: ~${totals.estimatedTokensSaved} tokens (${totals.charsSaved} chars) across ${totals.events} event(s).\n` +
            "This counts only exact, measured deltas mixai can prove from its own compression (compaction, " +
            "preview disclosure, prompt caps) — it does not estimate what re-exploring the repo without mixai would cost.\n",
        );
      }
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "show") {
    const selector = options.args[0];
    if (!selector) throw new Error("memory show requires a checkpoint id or numeric item id");
    const memory = await requireMemory(options);
    try {
      const record = showRecord(memory, selector);
      if (!record) throw new Error(`No memory record matched ${selector}`);
      process.stdout.write(`${JSON.stringify(record, null, options.json ? 0 : 2)}\n`);
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "compact") {
    if (!options.memoryConfig) throw new Error("memory compact needs the memory configuration; run it via the mixai CLI");
    const memory = await requireMemory(options);
    try {
      const drained = await drainConsolidationQueue(memory, options.distillRunner, options.memoryConfig);
      const compaction = await runCompaction(memory, options.distillRunner, options.memoryConfig);
      const report = { drained, compaction };
      if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
      else {
        if (drained.length === 0) process.stdout.write("Consolidation queue is empty.\n");
        for (const result of drained) {
          process.stdout.write(
            `${result.checkpointId}: ${result.status}${result.detail ? ` (${result.detail})` : ""}, ${result.itemsWritten} item(s)\n`,
          );
        }
        process.stdout.write(
          `Compaction: ${compaction.epochDigests} epoch digest(s), ${compaction.projectDigests} project digest(s)` +
            `${compaction.detail ? ` — ${compaction.detail}` : ""}\n`,
        );
      }
    } finally {
      memory.close();
    }
    return;
  }
  // Advanced/internal: the pre-compact hook spawns this detached so LLM
  // consolidation happens off the host agent's critical path. Also usable by
  // hand to retry one specific checkpoint.
  if (sub === "consolidate-checkpoint") {
    const checkpointId = options.args[0];
    if (!checkpointId) throw new Error("memory consolidate-checkpoint requires a checkpoint id");
    if (!options.memoryConfig) {
      throw new Error("memory consolidate-checkpoint needs the memory configuration; run it via the mixai CLI");
    }
    const result = await consolidateBestEffort(options.cwd, options.distillRunner, checkpointId, options.memoryConfig);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(
        `${result.checkpointId}: ${result.status}${result.detail ? ` (${result.detail})` : ""}, ${result.itemsWritten} item(s)\n`,
      );
    }
    return;
  }
  // Zero-token backfill: run the rules tier over checkpoints that never got
  // distilled (and with --all, over every checkpoint; restatements reinforce).
  // Hand-curated memory: add a fact, forget a wrong one, or make one apply to
  // every project (promote) / stop doing so (demote).
  if (sub === "add") {
    const text = options.args.join(" ").trim();
    if (!text) throw new Error('mixai memory add "<fact, decision, or preference>" [--category decision] [--min-importance 8]');
    const memory = await requireMemory(options);
    try {
      const category = MEMORY_CATEGORIES.includes(options.category as MemoryCategory) ? (options.category as MemoryCategory) : undefined;
      const saved = upsertMemoryItem(memory, {
        kind: "semantic",
        ...(category ? { category } : {}),
        text,
        importance: options.minImportance ?? 8,
        origin: "user",
      });
      await embedNewRows(memory, options.memoryConfig);
      process.stdout.write(options.json ? `${JSON.stringify(saved)}\n` : `${saved.reinforced ? "Already known; reinforced" : "Saved"} as memory item ${saved.id}.\n`);
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "forget") {
    const id = Number(options.args[0]);
    if (!Number.isInteger(id)) throw new Error("mixai memory forget <item-id>");
    const memory = await requireMemory(options);
    try {
      const changed = Number(memory.db.prepare("UPDATE memory_items SET status = 'archived' WHERE id = ? AND status = 'active'").run(id).changes) > 0;
      process.stdout.write(options.json ? `${JSON.stringify({ id, archived: changed })}\n` : changed ? `Forgot item ${id} (archived; it no longer appears).\n` : `No active item ${id}.\n`);
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "promote") {
    const id = Number(options.args[0]);
    if (!Number.isInteger(id)) throw new Error("mixai memory promote <item-id>");
    const memory = await requireMemory(options);
    try {
      const row = memory.db.prepare("SELECT text, category, importance FROM memory_items WHERE id = ?").get(id) as
        | { text: string; category: string | null; importance: number }
        | undefined;
      if (!row) throw new Error(`No memory item ${id}`);
      const globalId = promoteToGlobal(row.text, row.category, row.importance, resolveProject(options.cwd).id);
      process.stdout.write(options.json ? `${JSON.stringify({ globalId })}\n` : `Item ${id} now applies to all your projects (global ${globalId}).\n`);
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "demote") {
    const id = Number(options.args[0]);
    if (!Number.isInteger(id)) throw new Error("mixai memory demote <global-id>   (see mixai memory global)");
    const removed = demoteGlobal(id);
    process.stdout.write(options.json ? `${JSON.stringify({ removed })}\n` : removed ? `Removed global preference ${id}.\n` : `No global preference ${id}.\n`);
    return;
  }
  if (sub === "global") {
    const items = listGlobalItems(100);
    if (options.json) process.stdout.write(`${JSON.stringify(items)}\n`);
    else process.stdout.write(items.length ? `${items.map((item) => `${item.id}. ${item.text}`).join("\n")}\n` : "No preferences apply to all projects yet.\n");
    return;
  }
  if (sub === "export") {
    const memory = await requireMemory(options);
    try {
      const project = resolveProject(options.cwd);
      const passphrase = process.env.MIXAI_SYNC_PASSPHRASE || undefined;
      const target = options.path ?? join(options.cwd, `${project.name}${passphrase ? ".mixai.enc" : ".mixai.gz"}`);
      writeFileSync(target, encodeBundle(exportBundle(memory, project, { transcripts: Boolean(options.all) }), passphrase), { mode: 0o600 });
      process.stdout.write(options.json ? `${JSON.stringify({ path: target })}\n` : `Exported ${project.name}'s memory to ${target}${passphrase ? " (encrypted)" : ""}.\n`);
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "import") {
    const file = options.args[0] ?? options.path;
    if (!file) throw new Error("mixai memory import <bundle-file>");
    const memory = await requireMemory(options);
    try {
      const result = importBundle(memory, decodeBundle(readFileSync(file), process.env.MIXAI_SYNC_PASSPHRASE || undefined));
      await embedNewRows(memory, options.memoryConfig);
      process.stdout.write(
        options.json
          ? `${JSON.stringify(result)}\n`
          : `Imported ${result.items} new item(s) (${result.reinforced} already known), ${result.summaries} summaries, ${result.sessions} session(s), ${result.messages} message(s).\n`,
      );
    } finally {
      memory.close();
    }
    return;
  }
  if (sub === "distill") {
    const memory = await requireMemory(options);
    try {
      const result = distillWithRulesBackfill(memory, { all: Boolean(options.all) });
      if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else {
        process.stdout.write(
          `Distilled ${result.checkpoints} checkpoint(s) with local rules: ` +
            `${result.itemsWritten} new item(s), ${result.itemsReinforced} reinforced. No provider tokens used.\n`,
        );
      }
    } finally {
      memory.close();
    }
    return;
  }
  throw new Error(
    `Unknown memory subcommand: ${sub ?? "(none)"}. Use: search, show, add, forget, promote, demote, global, stats, spend, savings, distill, compact, reindex, export, import`,
  );
}
