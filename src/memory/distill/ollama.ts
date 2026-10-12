import type { LocalDistillModel } from "./runner.js";

const DETECT_TIMEOUT_MS = 300;

interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

interface OllamaGenerateResponse {
  response?: string;
}

// Same contract as embeddings.ts: a missing or unreachable Ollama, or a model
// that isn't pulled, degrades to "no local model" — never an error.
export async function detectOllamaChatModel(
  baseUrl: string,
  model: string,
  timeoutMs = DETECT_TIMEOUT_MS,
): Promise<LocalDistillModel | undefined> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as OllamaTagsResponse;
    const names = (body.models ?? []).map((entry) => entry.name ?? "");
    if (!names.some((name) => name === model || name.startsWith(`${model}:`))) return undefined;
  } catch {
    return undefined;
  }
  return {
    local: true,
    label: `ollama:${model}`,
    async generate(prompt, generateTimeoutMs) {
      const response = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt, stream: false }),
        signal: AbortSignal.timeout(generateTimeoutMs),
      });
      if (!response.ok) throw new Error(`Ollama generate failed with status ${response.status}`);
      const body = (await response.json()) as OllamaGenerateResponse;
      return body.response ?? "";
    },
  };
}
