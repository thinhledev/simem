import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureClaudeHandoffMemory } from "../src/handoff/claude-memory.js";

test("installs an idempotent private Claude handoff import with worktree support", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "simem-claude-memory-"));
  await writeFile(join(workspace, "CLAUDE.local.md"), "# My local instructions\n\nKeep this.\n");
  await writeFile(join(workspace, ".gitignore"), ".env\n");
  await writeFile(join(workspace, ".worktreeinclude"), ".env\n");

  const first = await ensureClaudeHandoffMemory(workspace);
  const second = await ensureClaudeHandoffMemory(workspace);
  const memory = await readFile(first.memoryPath, "utf8");
  const gitignore = await readFile(first.gitignorePath, "utf8");
  const worktree = await readFile(first.worktreeIncludePath, "utf8");

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.match(memory, /Keep this\./);
  assert.equal(memory.match(/simem:handoff:start/g)?.length, 1);
  assert.match(memory, /@\.simem\/current\/BRIEF\.md/);
  assert.match(gitignore, /^\.simem\/$/m);
  assert.match(gitignore, /^CLAUDE\.local\.md$/m);
  assert.match(worktree, /^\.simem\/current\/$/m);
  assert.match(worktree, /^CLAUDE\.local\.md$/m);
});
