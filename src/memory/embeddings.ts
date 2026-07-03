const DETECT_TIMEOUT_MS = 300;
const EMBED_TIMEOUT_MS = 10_000;

export interface EmbeddingClient {
  model: string;
  dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

// A missing/unreachable Ollama must never stall a switch: short timeout,
// any failure (refused connection, timeout, non-200, bad JSON) degrades to
// "no embeddings" rather than throwing.
export async function detectOllama(
  baseUrl: string,
  model: string,
  timeoutMs = DETECT_TIMEOUT_MS,
): Promise<EmbeddingClient | undefined> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as OllamaTagsResponse;
    const names = (body.models ?? []).map((entry) => entry.name ?? "");
    const hasModel = names.some((name) => name === model || name.startsWith(`${model}:`));
    if (!hasModel) return undefined;
    const dim = await probeDimension(baseUrl, model);
    if (!dim) return undefined;
    return { model, dim, embed: (texts) => embedBatch(baseUrl, model, texts) };
  } catch {
    return undefined;
  }
}

async function probeDimension(baseUrl: string, model: string): Promise<number | undefined> {
  try {
    const [vector] = await embedBatch(baseUrl, model, ["dimension probe"]);
    return vector?.length;
  } catch {
    return undefined;
  }
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
  embedding?: number[];
}

async function embedBatch(baseUrl: string, model: string, texts: string[]): Promise<Float32Array[]> {
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Ollama embed request failed with status ${response.status}`);
  const body = (await response.json()) as OllamaEmbedResponse;
  if (body.embeddings) return body.embeddings.map((vector) => Float32Array.from(vector));
  if (body.embedding) return [Float32Array.from(body.embedding)];
  throw new Error("Ollama embed response had no embeddings");
}

export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Buffer | Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
