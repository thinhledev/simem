import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingClient } from "../memory/embeddings.js";
import { simemHome } from "../store/home.js";
import { WordPieceTokenizer } from "./wordpiece.js";

// Model2Vec static embeddings: a token's vector is a row lookup; a text's
// vector is the mean of its tokens' rows, L2-normalized. No neural network
// runs, so a hook can load the model and embed a prompt in milliseconds.

export const BUILTIN_MODEL = "potion-base-8M";

export interface StaticModel {
  name: string;
  dim: number;
  tokenizer: WordPieceTokenizer;
  embeddings: Float32Array;
  encode(text: string): Float32Array;
}

// Long texts are capped; static embeddings gain little past this many tokens.
const MAX_TOKENS = 1_024;

export function modelDir(name = BUILTIN_MODEL): string {
  return join(simemHome(), "models", name);
}

export function readSafetensorsF32(buffer: Buffer, tensor: string): { data: Float32Array; shape: number[] } {
  const headerLength = Number(buffer.readBigUInt64LE(0));
  const header = JSON.parse(buffer.subarray(8, 8 + headerLength).toString("utf8")) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const entry = header[tensor];
  if (!entry) throw new Error(`safetensors file has no tensor named ${tensor}`);
  if (entry.dtype !== "F32") throw new Error(`expected F32 ${tensor}, got ${entry.dtype}`);
  const start = 8 + headerLength + entry.data_offsets[0];
  const end = 8 + headerLength + entry.data_offsets[1];
  // Copy into an aligned buffer: the data section's offset need not be a multiple of 4.
  const aligned = new ArrayBuffer(end - start);
  new Uint8Array(aligned).set(buffer.subarray(start, end));
  return { data: new Float32Array(aligned), shape: entry.shape };
}

export function vocabFromTokenizerJson(raw: string): Map<string, number> {
  const parsed = JSON.parse(raw) as { model?: { vocab?: Record<string, number> } };
  const vocab = parsed.model?.vocab;
  if (!vocab) throw new Error("tokenizer.json has no model.vocab");
  return new Map(Object.entries(vocab));
}

export function createStaticModel(name: string, vocab: Map<string, number>, embeddings: Float32Array, dim: number): StaticModel {
  const tokenizer = new WordPieceTokenizer({ vocab });
  const rows = embeddings.length / dim;
  return {
    name,
    dim,
    tokenizer,
    embeddings,
    encode(text: string): Float32Array {
      const out = new Float32Array(dim);
      let count = 0;
      for (const id of tokenizer.encode(text, MAX_TOKENS)) {
        // Unknown tokens are dropped, as model2vec does.
        if (id === tokenizer.unkId || id >= rows) continue;
        const offset = id * dim;
        for (let i = 0; i < dim; i += 1) out[i]! += embeddings[offset + i]!;
        count += 1;
      }
      if (count === 0) return out;
      let norm = 0;
      for (let i = 0; i < dim; i += 1) {
        out[i]! /= count;
        norm += out[i]! * out[i]!;
      }
      norm = Math.sqrt(norm) + 1e-32;
      for (let i = 0; i < dim; i += 1) out[i]! /= norm;
      return out;
    },
  };
}

const loaded = new Map<string, StaticModel | null>();

// Loads a downloaded model (see install.ts); undefined when not installed.
export function loadStaticModel(name = BUILTIN_MODEL, dir = modelDir(name)): StaticModel | undefined {
  const key = `${name}:${dir}`;
  const cached = loaded.get(key);
  if (cached !== undefined) return cached ?? undefined;
  try {
    if (!existsSync(join(dir, "model.safetensors"))) {
      loaded.set(key, null);
      return undefined;
    }
    const vocab = vocabFromTokenizerJson(readFileSync(join(dir, "tokenizer.json"), "utf8"));
    const { data, shape } = readSafetensorsF32(readFileSync(join(dir, "model.safetensors")), "embeddings");
    const model = createStaticModel(name, vocab, data, shape[1] ?? 256);
    loaded.set(key, model);
    return model;
  } catch {
    loaded.set(key, null);
    return undefined;
  }
}

export function staticEmbeddingClient(model: StaticModel): EmbeddingClient {
  return {
    model: model.name,
    dim: model.dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => model.encode(text));
    },
  };
}
