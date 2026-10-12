import { DEFAULT_CONFIG } from "../config.js";
import { openMemoryDb, type MemoryDb } from "../memory/db.js";
import type { EmbeddingClient } from "../memory/embeddings.js";
import { toBlob } from "../memory/embeddings.js";
import { search, type InjectionGate } from "../memory/retrieval.js";
import { EVAL_MEMORIES, EVAL_QUERIES, type EvalQuery } from "./eval-set.js";

export interface EvalMetrics {
  exactRecall: number;
  rewordedRecall: number;
  /** Share of injected hits that were the expected memory. */
  precision: number;
  /** Negative prompts that injected anything. */
  falseInjections: number;
  injected: number;
}

async function seed(embeddings?: EmbeddingClient): Promise<{ memory: MemoryDb; ids: Map<number, string> }> {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:", quiet: true });
  if (!memory) throw new Error("simem eval requires node:sqlite (Node.js >= 22.5)");
  const ids = new Map<number, string>();
  const insert = memory.db.prepare(
    "INSERT INTO memory_items (kind, category, text, importance, created_at, last_reinforced_at, embedding, embedding_model) VALUES ('semantic', 'fact', ?, 7, ?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  const vectors = embeddings ? await embeddings.embed(EVAL_MEMORIES.map((memory) => memory.text)) : [];
  EVAL_MEMORIES.forEach((entry, index) => {
    const vector = vectors[index];
    const result = insert.run(entry.text, now, now, vector ? toBlob(vector) : null, vector ? embeddings!.model : null);
    ids.set(Number(result.lastInsertRowid), entry.key);
  });
  return { memory, ids };
}

export async function evaluateGate(gate: InjectionGate, embeddings?: EmbeddingClient, queries: EvalQuery[] = EVAL_QUERIES): Promise<EvalMetrics> {
  const { memory, ids } = await seed(embeddings);
  try {
    const found = { exact: 0, reworded: 0 };
    const totals = { exact: 0, reworded: 0 };
    let correct = 0;
    let injected = 0;
    let falseInjections = 0;
    for (const query of queries) {
      const hits = await search(memory, query.query, {
        limit: 3,
        excludeMessages: true,
        scoring: DEFAULT_CONFIG.memory.scoring,
        ...gate,
        ...(embeddings ? { embeddings } : {}),
      });
      injected += hits.length;
      const keys = hits.map((hit) => ids.get(hit.id));
      if (query.expect === null) {
        if (hits.length > 0) falseInjections += 1;
        continue;
      }
      totals[query.kind as "exact" | "reworded"] += 1;
      if (keys.includes(query.expect)) found[query.kind as "exact" | "reworded"] += 1;
      correct += keys.filter((key) => key === query.expect).length;
    }
    return {
      exactRecall: totals.exact ? found.exact / totals.exact : 0,
      rewordedRecall: totals.reworded ? found.reworded / totals.reworded : 0,
      precision: injected ? correct / injected : 1,
      falseInjections,
      injected,
    };
  } finally {
    memory.close();
  }
}

export interface Calibration {
  minSimilarity: number;
  strongSimilarity: number;
  metrics: EvalMetrics;
}

// Grid search for the vector cutoffs: the most reworded recall with precision
// >= 0.9 and no false injection on the negative prompts.
export async function calibrate(embeddings: EmbeddingClient): Promise<Calibration | undefined> {
  let best: Calibration | undefined;
  for (let strong = 0.2; strong <= 0.6001; strong += 0.02) {
    for (let min = 0.06; min <= strong; min += 0.02) {
      const gate: InjectionGate = { minCoverage: 0.5, minMatchedTerms: 2, minSimilarity: round(min), strongSimilarity: round(strong), anchorCoverage: 0.2 };
      const metrics = await evaluateGate(gate, embeddings);
      if (metrics.precision < 0.9 || metrics.falseInjections > 0) continue;
      const score = metrics.rewordedRecall * 2 + metrics.exactRecall;
      const bestScore = best ? best.metrics.rewordedRecall * 2 + best.metrics.exactRecall : -1;
      if (score > bestScore) best = { minSimilarity: round(min), strongSimilarity: round(strong), metrics };
    }
  }
  return best;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
