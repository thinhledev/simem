import type { MemoryConfig } from "../config.js";
import type { MemoryDb } from "../memory/db.js";
import { detectOllama, type EmbeddingClient } from "../memory/embeddings.js";
import { embedMissing } from "../memory/reindex.js";
import { loadStaticModel, staticEmbeddingClient } from "./model.js";

// The embedding backend for a config: the built-in static model when it is
// installed (works offline, no Ollama, no native code), or Ollama when chosen.
// Undefined means keyword-only retrieval — everything still works.
export async function resolveEmbeddings(config: MemoryConfig | undefined): Promise<EmbeddingClient | undefined> {
  if (!config?.embeddings.enabled) return undefined;
  if (config.embeddings.provider === "ollama") return await detectOllama(config.embeddings.ollamaUrl, config.embeddings.model);
  const model = loadStaticModel(config.embeddings.builtinModel);
  return model ? staticEmbeddingClient(model) : undefined;
}

// Embeds rows written since the last pass. Cheap with the static model
// (microseconds per row), so it runs right after ingestion and saves.
export async function embedNewRows(memory: MemoryDb, config: MemoryConfig | undefined): Promise<void> {
  try {
    const client = await resolveEmbeddings(config);
    if (client) await embedMissing(memory, client);
  } catch {
    // Vectors are an enhancement; keyword search covers a failure here.
  }
}
