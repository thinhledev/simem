import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const START = "<!-- mixai:handoff:start -->";
const END = "<!-- mixai:handoff:end -->";
const BLOCK = `${START}
## Mixai cross-agent handoff

The imported checkpoint below is continuity context from another coding agent. When the user asks to continue, inspect the live repository state and resume the latest unfinished objective without asking them to repeat completed work.

@.mixai/current/HANDOFF.md
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

export async function ensureClaudeHandoffMemory(cwd: string): Promise<ClaudeMemoryIntegration> {
  const root = resolve(cwd);
  const memoryPath = join(root, "CLAUDE.local.md");
  const gitignorePath = join(root, ".gitignore");
  const worktreeIncludePath = join(root, ".worktreeinclude");
  const original = await readOptional(memoryPath);
  const start = original.indexOf(START);
  const end = original.indexOf(END);
  let memory = original;
  if (start >= 0 && end >= start) {
    memory = `${original.slice(0, start)}${BLOCK}${original.slice(end + END.length)}`;
  } else {
    const prefix = original && !original.endsWith("\n") ? `${original}\n` : original;
    memory = `${prefix}${prefix ? "\n" : ""}${BLOCK}\n`;
  }
  const memoryChanged = memory !== original;
  if (memoryChanged) await writeFile(memoryPath, memory, "utf8");

  const gitignoreChanged = await ensureLines(gitignorePath, [".mixai/", "CLAUDE.local.md"]);
  const worktreeOriginal = await readOptional(worktreeIncludePath);
  const worktreeMigrated = worktreeOriginal
    .split(/\r?\n/)
    .filter((line) => line.trim() !== ".mixai/CURRENT.md")
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  const worktreeMigrationChanged = worktreeMigrated !== worktreeOriginal.trim();
  if (worktreeMigrationChanged) {
    await writeFile(worktreeIncludePath, worktreeMigrated ? `${worktreeMigrated}\n` : "", "utf8");
  }
  const worktreeChanged = await ensureLines(worktreeIncludePath, [".mixai/current/", "CLAUDE.local.md"]);
  return {
    memoryPath,
    gitignorePath,
    worktreeIncludePath,
    changed: memoryChanged || gitignoreChanged || worktreeMigrationChanged || worktreeChanged,
  };
}
