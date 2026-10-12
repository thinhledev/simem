import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../store/home.js";
import { BUILTIN_MODEL, modelDir } from "./model.js";

export interface ModelSpec {
  name: string;
  /** Base URL of the files, pinned to an exact revision. */
  baseUrl: string;
  /** file name → expected sha256 */
  files: Record<string, string>;
  /** Approximate download size, for messages. */
  megabytes: number;
}

// minishlab/potion-base-8M (MIT), pinned to one Hugging Face commit and
// verified by SHA-256, so a changed or tampered upstream file is rejected.
export const BUILTIN_MODEL_SPEC: ModelSpec = {
  name: BUILTIN_MODEL,
  baseUrl: "https://huggingface.co/minishlab/potion-base-8M/resolve/bf8b056651a2c21b8d2565580b8569da283cab23",
  files: {
    "model.safetensors": "f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2",
    "tokenizer.json": "e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50",
    "config.json": "2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553",
  },
  megabytes: 31,
};

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function modelInstalled(spec: ModelSpec = BUILTIN_MODEL_SPEC, dir = modelDir(spec.name)): boolean {
  return Object.entries(spec.files).every(([file, hash]) => {
    try {
      return sha256(readFileSync(join(dir, file))) === hash;
    } catch {
      return false;
    }
  });
}

export type ModelInstallOutcome = { status: "present" | "installed" } | { status: "failed"; reason: string };

export async function installModel(
  spec: ModelSpec = BUILTIN_MODEL_SPEC,
  dir = modelDir(spec.name),
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInstallOutcome> {
  if (modelInstalled(spec, dir)) return { status: "present" };
  ensurePrivateDir(dir);
  for (const [file, expected] of Object.entries(spec.files)) {
    const target = join(dir, file);
    if (existsSync(target) && sha256(readFileSync(target)) === expected) continue;
    const partial = `${target}.partial`;
    try {
      const response = await fetchImpl(`${spec.baseUrl}/${file}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) return { status: "failed", reason: `${file}: HTTP ${response.status}` };
      const buffer = Buffer.from(await response.arrayBuffer());
      const actual = sha256(buffer);
      if (actual !== expected) return { status: "failed", reason: `${file}: checksum mismatch (got ${actual.slice(0, 12)}…)` };
      writeFileSync(partial, buffer);
      renameSync(partial, target);
    } catch (error) {
      try {
        unlinkSync(partial);
      } catch {
        // Nothing partial left behind.
      }
      return { status: "failed", reason: `${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { status: "installed" };
}
