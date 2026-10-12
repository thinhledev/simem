import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LEGACY_HANDOFF_END, LEGACY_HANDOFF_START, stripMarkedBlock } from "../legacy.js";
import { briefFromHandoff } from "./checkpoints.js";

const START = "<!-- simem:handoff:start -->";
const END = "<!-- simem:handoff:end -->";
// Imports the LEAN brief, not the full HANDOFF.md. An @import is persistent
// system-prompt context re-sent on every turn, so importing the full handoff
// (recent transcript + memory, often tens of KB) taxes every message. BRIEF.md
// carries just the objective + a pointer; the full handoff is one Read away.
const BLOCK = `${START}
## simem cross-agent handoff

The brief below is compact continuity context from another coding agent. When the user asks to continue, inspect the live repository state and resume the latest unfinished objective without asking them to repeat completed work. For the full prior-agent handoff, read \`.simem/current/HANDOFF.md\`.

@.simem/current/BRIEF.md
${END}`;

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function ensureLines(path: string, lines: string[]): Promise<boolean> {
  const original = await readOptional(path);
  const existing = new Set(original.split(/\r?\n/).map((line) => line.trim()));
  const missing = lines.filter((line) => !existing.has(line));
  if (missing.length === 0) return false;
  const prefix = original && !original.endsWith("\n") ? `${original}\n` : original;
  await writeFile(path, `${prefix}${prefix ? "\n" : ""}${missing.join("\n")}\n`, "utf8");
  return true;
}

export interface ClaudeMemoryIntegration {
  memoryPath: string;
  gitignorePath: string;
  worktreeIncludePath: string;
  changed: boolean;
}

// Migration: workspaces whose latest checkpoint predates BRIEF.md still have
// the block point at BRIEF.md now — so derive one from the existing HANDOFF.md
// (best-effort) to avoid a dangling @import until the next checkpoint writes it.
async function ensureBriefFile(cwd: string): Promise<void> {
  const currentDir = join(cwd, ".simem", "current");
  const briefPath = join(currentDir, "BRIEF.md");
  if (await readOptional(briefPath)) return;
  const handoff = await readOptional(join(currentDir, "HANDOFF.md"));
  if (!handoff) return;
  const brief = briefFromHandoff(handoff);
  if (brief) await writeFile(briefPath, brief, "utf8");
}

export async function ensureClaudeHandoffMemory(cwd: string): Promise<ClaudeMemoryIntegration> {
  const root = resolve(cwd);
  const memoryPath = join(root, "CLAUDE.local.md");
  const gitignorePath = join(root, ".gitignore");
  const worktreeIncludePath = join(root, ".worktreeinclude");
  await ensureBriefFile(root);
  // mixai 1.x's import block is replaced by this one.
  const raw = await readOptional(memoryPath);
  const original = stripMarkedBlock(raw, LEGACY_HANDOFF_START, LEGACY_HANDOFF_END);
  const start = original.indexOf(START);
  const end = original.indexOf(END);
  let memory = original;
  if (start >= 0 && end >= start) {
    memory = `${original.slice(0, start)}${BLOCK}${original.slice(end + END.length)}`;
  } else {
    const prefix = original && !original.endsWith("\n") ? `${original}\n` : original;
    memory = `${prefix}${prefix ? "\n" : ""}${BLOCK}\n`;
  }
  const memoryChanged = memory !== raw;
  if (memoryChanged) await writeFile(memoryPath, memory, "utf8");

  const gitignoreChanged = await ensureLines(gitignorePath, [".simem/", "CLAUDE.local.md"]);
  const worktreeOriginal = await readOptional(worktreeIncludePath);
  const worktreeMigrated = worktreeOriginal
    .split(/\r?\n/)
    .filter((line) => line.trim() !== ".simem/CURRENT.md")
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  const worktreeMigrationChanged = worktreeMigrated !== worktreeOriginal.trim();
  if (worktreeMigrationChanged) {
    await writeFile(worktreeIncludePath, worktreeMigrated ? `${worktreeMigrated}\n` : "", "utf8");
  }
  const worktreeChanged = await ensureLines(worktreeIncludePath, [".simem/current/", "CLAUDE.local.md"]);
  return {
    memoryPath,
    gitignorePath,
    worktreeIncludePath,
    changed: memoryChanged || gitignoreChanged || worktreeMigrationChanged || worktreeChanged,
  };
}
