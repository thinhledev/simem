import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MemoryConfig } from "../config.js";
import { assembleContext } from "../memory/budget.js";
import { openMemoryDb } from "../memory/db.js";
import { capText } from "../memory/text-cap.js";
import { projectStoreDir } from "../store/project.js";
import type { CommandRunner } from "../process.js";
import type { CheckpointManifest } from "./types.js";
import { captureWorkspaceSummary } from "./workspace.js";

export const DEFAULT_BRIEF_MAX_CHARS = 4_000;

// Per-section cap for the objective/outcome blocks so a long final message
// can't crowd the live git state and memory sections out of the total budget.
const SUMMARY_SECTION_CAP = 1_200;

export interface BriefOptions {
  cwd: string;
  /** Retrieval query and displayed objective; defaults to the latest checkpoint's. */
  objective?: string;
  maxChars?: number;
  memoryConfig: MemoryConfig;
}

export interface Brief {
  /** Markdown revival brief; never empty — at minimum the live workspace state. */
  text: string;
  truncated: boolean;
  /** True when the persistent memory database contributed a Project memory section. */
  hasMemory: boolean;
}

async function latestManifest(cwd: string): Promise<CheckpointManifest | undefined> {
  try {
    const raw = await readFile(join(projectStoreDir(cwd), "current", "manifest.json"), "utf8");
    const manifest = JSON.parse(raw) as CheckpointManifest;
    return manifest.version === 1 ? manifest : undefined;
  } catch {
    return undefined;
  }
}

// Fallback for checkpoints created before manifest.summary existed: pull the
// section body out of the mirrored HANDOFF.md.
function handoffSection(handoff: string, heading: string): string | undefined {
  const pattern = new RegExp(`^## ${heading}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
  const body = pattern.exec(handoff)?.[1]?.trim();
  return body || undefined;
}

async function latestSummary(
  cwd: string,
  manifest: CheckpointManifest | undefined,
): Promise<{ objective?: string; outcome?: string }> {
  if (manifest?.summary) {
    return { objective: manifest.summary.latestObjective, outcome: manifest.summary.latestOutcome };
  }
  try {
    const handoff = await readFile(join(projectStoreDir(cwd), "current", "HANDOFF.md"), "utf8");
    const objective = handoffSection(handoff, "Latest user objective");
    const outcome = handoffSection(handoff, "Latest agent outcome");
    return {
      ...(objective !== undefined ? { objective } : {}),
      ...(outcome !== undefined ? { outcome } : {}),
    };
  } catch {
    return {};
  }
}

// Best-effort: "" when memory is disabled, unavailable (Node < 22.5), or has
// nothing to say — the brief still carries checkpoint + live git state.
async function memorySection(cwd: string, objective: string, config: MemoryConfig): Promise<{ text: string; truncated: boolean }> {
  if (!config.enabled) return { text: "", truncated: false };
  try {
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return { text: "", truncated: false };
    try {
      return await assembleContext(memory, objective, config.budget, config.scoring);
    } finally {
      memory.close();
    }
  } catch {
    return { text: "", truncated: false };
  }
}

// Deterministic revival brief: latest checkpoint objective/outcome + live git
// state + budgeted project memory. Zero LLM calls by design — this is the
// thing an agent (or a session-start hook) reads to recover context after a
// compaction/reset without re-exploring the repository.
export async function buildBrief(runner: CommandRunner, options: BriefOptions): Promise<Brief> {
  const cwd = resolve(options.cwd);
  const maxChars = options.maxChars ?? DEFAULT_BRIEF_MAX_CHARS;
  const manifest = await latestManifest(cwd);
  const summary = await latestSummary(cwd, manifest);
  const objective = options.objective?.trim() || summary.objective || "";
  const workspace = await captureWorkspaceSummary(runner, cwd);
  const memory = await memorySection(cwd, objective, options.memoryConfig);

  const objectiveBlock = capText(objective || "Unknown — no checkpoint has been created in this workspace yet.", SUMMARY_SECTION_CAP);
  const outcomeBlock = summary.outcome ? capText(summary.outcome, SUMMARY_SECTION_CAP) : undefined;

  const parts: string[] = [
    `## Context brief (simem local memory)`,
    manifest
      ? `Checkpoint: ${manifest.id} (${manifest.createdAt}, from ${manifest.source.provider})\nWorkspace: ${cwd}`
      : `Checkpoint: none yet\nWorkspace: ${cwd}`,
    `### Latest objective\n\n${objectiveBlock.text}`,
    ...(outcomeBlock ? [`### Latest agent outcome\n\n${outcomeBlock.text}`] : []),
    `### Workspace state (live)\n\n- Branch: ${workspace.branch ?? "unborn or detached"}\n- HEAD: ${workspace.head ?? "no commit"}\n\n\`\`\`text\n${workspace.status || "Clean or unavailable"}\n\`\`\``,
    ...(memory.text ? [memory.text.trimEnd()] : []),
  ];

  const body = parts.join("\n\n");
  const capped = capText(body, maxChars);
  return {
    text: `${capped.text}\n`,
    truncated: capped.truncated || memory.truncated || objectiveBlock.truncated || Boolean(outcomeBlock?.truncated),
    hasMemory: Boolean(memory.text),
  };
}
