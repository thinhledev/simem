import type { GatewayConfig } from "../config.js";
import { openMemoryDb } from "../memory/db.js";
import { toPreview } from "../memory/preview.js";
import { search } from "../memory/retrieval.js";
import { queryTerms } from "../memory/retrieval.js";
import { listGlobalItems } from "../sources/native.js";
import { resolveEmbeddings } from "../vec/client.js";
import { AUTOMATIC_INJECTION_GATE, automaticGate } from "../memory/retrieval.js";
import { calibrate, evaluateGate } from "../vec/eval.js";
import { print, type Output } from "./common.js";

// `mixai recall "<question>"`: what does memory know about this? Deterministic,
// local, and the same search the agent's `recall` tool runs.
export async function runRecall(question: string, options: Output & { cwd: string; config: GatewayConfig; limit?: number }): Promise<void> {
  if (!question.trim()) throw new Error('mixai recall "<question>"');
  const memory = await openMemoryDb(options.cwd, { quiet: true });
  if (!memory) throw new Error(`Memory requires Node.js >= 22.5; this is ${process.version}`);
  try {
    const embeddings = await resolveEmbeddings(options.config.memory);
    const hits = await search(memory, question, {
      limit: options.limit ?? 8,
      scoring: options.config.memory.scoring,
      ...(embeddings ? { embeddings } : {}),
    });
    const terms = new Set(queryTerms(question));
    const global = listGlobalItems(100).filter((item) => queryTerms(item.text).some((term) => terms.has(term))).slice(0, 3);
    if (options.json) return print(options, "", { hits: hits.map((hit) => toPreview(hit)), global, vectors: Boolean(embeddings) });
    if (hits.length === 0 && global.length === 0) return print(options, "Nothing in memory matches that yet.");
    const lines = hits.map((hit) => `- [${hit.source} ${hit.id}] ${toPreview(hit, 220).preview}`);
    for (const item of global) lines.push(`- [you, all projects] ${item.text}`);
    lines.push("", `Full text: mixai memory show <id>${embeddings ? "" : "   (keyword search only — run `mixai init` to add the local embedding model)"}`);
    print(options, lines.join("\n"));
  } finally {
    memory.close();
  }
}

// `mixai eval`: measures the automatic-injection gate on the labelled set,
// keyword-only vs with the configured embeddings, and (with --all) searches
// for vector cutoffs to put in config.
export async function runEval(options: Output & { config: GatewayConfig; calibrate: boolean }): Promise<void> {
  const embeddings = await resolveEmbeddings(options.config.memory);
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const keyword = await evaluateGate(AUTOMATIC_INJECTION_GATE);
  const configured = embeddings ? await evaluateGate(automaticGate(options.config.memory.embeddings), embeddings) : undefined;
  const deliberateKeyword = await evaluateGate({ minCoverage: 0, minMatchedTerms: 0 });
  const deliberateHybrid = embeddings ? await evaluateGate({ minCoverage: 0, minMatchedTerms: 0 }, embeddings) : undefined;
  const result: Record<string, unknown> = { model: embeddings?.model ?? null, keyword, configured, deliberateKeyword, deliberateHybrid };
  const lines = [
    `Automatic injection (keyword gate): exact ${pct(keyword.exactRecall)}, reworded ${pct(keyword.rewordedRecall)}, precision ${pct(keyword.precision)}, false injections ${keyword.falseInjections}`,
  ];
  if (configured) {
    lines.push(`Automatic injection (configured gate, ${embeddings!.model}): exact ${pct(configured.exactRecall)}, reworded ${pct(configured.rewordedRecall)}, precision ${pct(configured.precision)}, false injections ${configured.falseInjections}`);
  }
  lines.push(`Deliberate search, top 3 (keyword): exact ${pct(deliberateKeyword.exactRecall)}, reworded ${pct(deliberateKeyword.rewordedRecall)}`);
  if (deliberateHybrid) lines.push(`Deliberate search, top 3 (with ${embeddings!.model}): exact ${pct(deliberateHybrid.exactRecall)}, reworded ${pct(deliberateHybrid.rewordedRecall)}`);
  if (options.calibrate) {
    if (!embeddings) throw new Error("No embedding model available to calibrate; run `mixai init` or configure Ollama.");
    const best = await calibrate(embeddings);
    result.calibration = best ?? null;
    lines.push(
      best
        ? `Suggested cutoffs for ${embeddings.model}: "minSimilarity": ${best.minSimilarity}, "strongSimilarity": ${best.strongSimilarity} ` +
            `(reworded ${pct(best.metrics.rewordedRecall)} at precision ${pct(best.metrics.precision)}). Set them under memory.embeddings in ~/.mixai/config.json only if the margin looks comfortable.`
        : `No cutoff for ${embeddings.model} reaches 90% precision without false injections; keep the vector gate off.`,
    );
  }
  print(options, lines.join("\n"), result);
}
