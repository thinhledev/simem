import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractTranscript } from "../handoff/sessions.js";
import type { CheckpointManifest, SessionInfo, TranscriptMessage } from "../handoff/types.js";
import type { MemoryDb } from "./db.js";
import { resetMemoryDb } from "./db.js";
import type { EmbeddingClient } from "./embeddings.js";
import { toBlob } from "./embeddings.js";
import { projectStoreDir } from "../store/project.js";
import { indexCheckpoint } from "./index-checkpoint.js";

export interface ReindexResult {
  checkpoints: number;
  messages: number;
  skipped: Array<{ id: string; reason: string }>;
}

function isManifest(value: unknown): value is CheckpointManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as CheckpointManifest;
  return (
    manifest.version === 1 &&
    typeof manifest.id === "string" &&
    typeof manifest.createdAt === "string" &&
    typeof manifest.workspace === "string" &&
    Boolean(manifest.source) &&
    Boolean(manifest.lineage) &&
    Boolean(manifest.workspaceSnapshot)
  );
}

// TRANSCRIPT.md is derived output; the original session JSONL is the more
// reliable source. Parse the markdown only when the session file is gone.
export function parseTranscriptMarkdown(content: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const section of content.split(/\n\n---\n\n/)) {
    const headerIndex = section.indexOf("## ");
    if (headerIndex === -1) continue;
    const body = section.slice(headerIndex);
    const newline = body.indexOf("\n");
    const header = (newline === -1 ? body : body.slice(0, newline)).trim();
    const match = /^## (User|Assistant)(?: · (.+))?$/.exec(header);
    if (!match) continue;
    const text = (newline === -1 ? "" : body.slice(newline + 1)).trim();
    if (!text) continue;
    const role = match[1] === "User" ? "user" : "assistant";
    messages.push({ role, text, ...(match[2] ? { timestamp: match[2] } : {}) });
  }
  return messages;
}

async function loadMessages(directory: string, manifest: CheckpointManifest): Promise<TranscriptMessage[]> {
  const sessionPath = manifest.source.sessionPath;
  try {
    await access(sessionPath);
    const session: SessionInfo = {
      provider: manifest.source.provider,
      id: manifest.source.sessionId,
      path: sessionPath,
      cwd: manifest.workspace,
      modifiedAt: manifest.source.sessionModifiedAt,
    };
    const messages = await extractTranscript(session);
    if (messages.length > 0) return messages;
  } catch {
    // Session file gone or unreadable; fall back to the exported transcript.
  }
  try {
    return parseTranscriptMarkdown(await readFile(join(directory, manifest.artifacts.transcript), "utf8"));
  } catch {
    return [];
  }
}

export async function reindexMemory(
  memory: MemoryDb,
  cwd: string,
  options: { rebuild?: boolean } = {},
): Promise<ReindexResult> {
  if (options.rebuild) resetMemoryDb(memory);
  const result: ReindexResult = { checkpoints: 0, messages: 0, skipped: [] };
  const checkpointsRoot = join(projectStoreDir(cwd), "checkpoints");
  let entries;
  try {
    entries = await readdir(checkpointsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(checkpointsRoot, entry.name);
    let manifest: CheckpointManifest;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      if (!isManifest(parsed)) {
        result.skipped.push({ id: entry.name, reason: "unrecognized manifest shape" });
        continue;
      }
      manifest = parsed;
    } catch (error) {
      result.skipped.push({
        id: entry.name,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const messages = await loadMessages(directory, manifest);
    indexCheckpoint(memory, manifest, messages, directory);
    result.checkpoints += 1;
    result.messages += messages.length;
  }
  return result;
}

export interface EmbedBackfillResult {
  items: number;
  summaries: number;
}

// Embeds every memory_item/summary that has no vector yet, or whose vector
// was computed with a different model (mixed embedding spaces are never
// compared, so a stale-model row is treated the same as a missing one).
export async function embedMissing(memory: MemoryDb, client: EmbeddingClient): Promise<EmbedBackfillResult> {
  const result: EmbedBackfillResult = { items: 0, summaries: 0 };
  const items = memory.db
    .prepare(
      "SELECT id, text FROM memory_items WHERE embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?",
    )
    .all(client.model) as Array<{ id: number; text: string }>;
  const updateItem = memory.db.prepare("UPDATE memory_items SET embedding = ?, embedding_model = ? WHERE id = ?");
  for (const item of items) {
    const [vector] = await client.embed([item.text]);
    if (!vector) continue;
    updateItem.run(toBlob(vector), client.model, item.id);
    result.items += 1;
  }

  const summaries = memory.db
    .prepare(
      "SELECT id, text FROM summaries WHERE embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?",
    )
    .all(client.model) as Array<{ id: number; text: string }>;
  const updateSummary = memory.db.prepare("UPDATE summaries SET embedding = ?, embedding_model = ? WHERE id = ?");
  for (const summary of summaries) {
    const [vector] = await client.embed([summary.text]);
    if (!vector) continue;
    updateSummary.run(toBlob(vector), client.model, summary.id);
    result.summaries += 1;
  }

  memory.db
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('embedding_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(client.model);
  return result;
}
