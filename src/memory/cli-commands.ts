import type { MemoryConfig } from "../config.js";
import { runCompaction } from "./compaction.js";
import { consolidateBestEffort, drainConsolidationQueue, type ConsolidationRunner } from "./consolidate.js";
import type { MemoryDb } from "./db.js";
import { openMemoryDb } from "./db.js";
import { detectOllama } from "./embeddings.js";
import { spendSummary, spendTotals } from "./ledger.js";
import { toPreview } from "./preview.js";
import { embedMissing, reindexMemory } from "./reindex.js";
import { search } from "./retrieval.js";
import { MEMORY_CATEGORIES, MEMORY_KINDS, type MemoryCategory, type MemoryKind, type MemoryStats } from "./types.js";

async function embeddingClient(memoryConfig: MemoryConfig | undefined) {
  if (!memoryConfig?.embeddings.enabled) return undefined;
  return await detectOllama(memoryConfig.embeddings.ollamaUrl, memoryConfig.embeddings.model);
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
  orchestrator?: ConsolidationRunner;
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
        if (options.json) process.stdout.write(`${JSON.stringify(previews)}\n`);
        else if (previews.length === 0) process.stdout.write("No matches.\n");
        else {
          for (const preview of previews) {
            const origin = preview.checkpointId ? ` (${preview.checkpointId})` : "";
            process.stdout.write(
              `[${preview.score.toFixed(3)}] ${preview.source}#${preview.id}${origin}\n  ${preview.preview}\n`,
            );
          }
          process.stdout.write("Pass --full for complete text, or `cag memory show <id>` to drill into one.\n");
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
      if (options.json) process.stdout.write(`${JSON.stringify({ ...stats, spend })}\n`);
      else {
        process.stdout.write(`Memory database: ${stats.dbPath}\n`);
        process.stdout.write(`Schema v${stats.schemaVersion}, FTS5 ${stats.fts ? "enabled" : "unavailable"}\n`);
        process.stdout.write(`Checkpoints: ${stats.checkpoints}, messages: ${stats.messages}\n`);
        process.stdout.write(`Memory items: ${JSON.stringify(stats.memoryItems)}\n`);
        process.stdout.write(`Summaries: ${JSON.stringify(stats.summariesByLevel)}\n`);
        process.stdout.write(`Consolidation queue: ${stats.queueDepth}\n`);
        process.stdout.write(
          `LLM calls: ${spend.calls} (${spend.estimatedCalls} estimated), ` +
            `${spend.inputTokens}+${spend.outputTokens} tokens, $${spend.costUsd.toFixed(4)}. Run \`cag memory spend\` for a breakdown.\n`,
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
    if (!options.orchestrator || !options.memoryConfig) {
      throw new Error("memory compact needs the routing configuration; run it via the cag CLI");
    }
    const memory = await requireMemory(options);
    try {
      const drained = await drainConsolidationQueue(memory, options.orchestrator, options.memoryConfig);
      const compaction = await runCompaction(memory, options.orchestrator, options.memoryConfig);
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
    if (!options.orchestrator || !options.memoryConfig) {
      throw new Error("memory consolidate-checkpoint needs the routing configuration; run it via the cag CLI");
    }
    const result = await consolidateBestEffort(options.cwd, options.orchestrator, checkpointId, options.memoryConfig);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(
        `${result.checkpointId}: ${result.status}${result.detail ? ` (${result.detail})` : ""}, ${result.itemsWritten} item(s)\n`,
      );
    }
    return;
  }
  throw new Error(
    `Unknown memory subcommand: ${sub ?? "(none)"}. Use: search, show, stats, spend, compact, reindex`,
  );
}
