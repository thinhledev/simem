import type { MemoryBudgetConfig, MemoryScoringConfig } from "../config.js";
import type { MemoryDb } from "./db.js";
import type { EmbeddingClient } from "./embeddings.js";
import { search } from "./retrieval.js";
import { capText, oneLine, type CapResult } from "./text-cap.js";

export interface AssembledContext {
  /** The full "## Project memory" markdown block, or "" when there is nothing to show. */
  text: string;
  truncated: boolean;
}

// Per-item cap keeps one long raw message (e.g. a multi-paragraph transcript
// hit) from consuming the whole section budget and crowding out other items.
const MAX_BULLET_CHARS = 240;

function buildBulletSection(lines: string[], maxChars: number): CapResult {
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  const perItemCap = Math.min(MAX_BULLET_CHARS, Math.max(40, maxChars));
  for (const rawLine of lines) {
    const line = oneLine(rawLine);
    const clipped = line.length > perItemCap ? `${line.slice(0, perItemCap - 1)}…` : line;
    if (clipped.length < line.length) truncated = true;
    const bullet = `- ${clipped}`;
    if (used + bullet.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    kept.push(bullet);
    used += bullet.length + 1;
  }
  if (kept.length < lines.length) truncated = true;
  return { text: kept.join("\n"), truncated };
}

interface DurableItemRow {
  text: string;
  importance: number;
}

interface DigestRow {
  level: number;
  text: string;
}

function durableItems(memory: MemoryDb, minImportance: number): DurableItemRow[] {
  return memory.db
    .prepare(
      "SELECT text, importance FROM memory_items WHERE status = 'active' AND kind = 'semantic' AND importance >= ? " +
        "ORDER BY importance DESC, id DESC",
    )
    .all(minImportance) as unknown as DurableItemRow[];
}

function latestDigest(memory: MemoryDb): DigestRow | undefined {
  return memory.db
    .prepare(
      "SELECT level, text FROM summaries WHERE superseded_by IS NULL ORDER BY level DESC, created_at DESC LIMIT 1",
    )
    .get() as DigestRow | undefined;
}

export async function assembleContext(
  memory: MemoryDb,
  latestObjective: string,
  budget: MemoryBudgetConfig,
  scoring?: MemoryScoringConfig,
  minDurableImportance = 7,
  embeddings?: EmbeddingClient,
): Promise<AssembledContext> {
  const durable = durableItems(memory, minDurableImportance);
  const durableSection = buildBulletSection(durable.map((item) => item.text), budget.semanticChars);

  const durableTexts = new Set(durable.map((item) => item.text));
  // Dedupe on a normalized prefix: repeated/near-identical transcript hits
  // (common when the same summary gets restated across checkpoints) would
  // otherwise burn the whole section budget on one message.
  const seenPrefixes = new Set<string>();
  const rawHits = await search(memory, latestObjective, {
    limit: 16,
    ...(scoring ? { scoring } : {}),
    ...(embeddings ? { embeddings } : {}),
  });
  const hits = rawHits.filter((hit) => {
    if (durableTexts.has(hit.text)) return false;
    const key = oneLine(hit.text).slice(0, 120);
    if (seenPrefixes.has(key)) return false;
    seenPrefixes.add(key);
    return true;
  });
  const retrievedSection = buildBulletSection(
    hits.slice(0, 8).map((hit) => hit.text),
    budget.retrievedChars,
  );

  const digest = latestDigest(memory);
  const digestSection = digest ? capText(digest.text, budget.digestChars) : { text: "", truncated: false };

  if (!durableSection.text && !retrievedSection.text && !digestSection.text) {
    return { text: "", truncated: false };
  }

  const sections: string[] = [];
  if (durableSection.text) sections.push(`### Durable decisions & constraints\n\n${durableSection.text}`);
  if (retrievedSection.text) sections.push(`### Relevant history\n\n${retrievedSection.text}`);
  if (digestSection.text) sections.push(`### Project digest\n\n${digestSection.text}`);

  const truncated = durableSection.truncated || retrievedSection.truncated || digestSection.truncated;
  const footer = truncated
    ? `For more: \`cag memory search "<query>"\` or the MCP \`memory_search\` tool. (truncated — see \`cag memory search\`)`
    : `For more: \`cag memory search "<query>"\` or the MCP \`memory_search\` tool.`;

  const body = [...sections, footer].join("\n\n");
  const capped = capText(body, budget.totalChars);
  return { text: `## Project memory\n\n${capped.text}\n`, truncated: truncated || capped.truncated };
}
