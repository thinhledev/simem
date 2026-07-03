import type { CommandRunner } from "../process.js";
import type { WorkspaceSnapshot } from "./types.js";

async function git(runner: CommandRunner, cwd: string, args: string[]): Promise<string> {
  const result = await runner.run({ command: "git", args, cwd, timeoutMs: 15_000 });
  return result.exitCode === 0 ? result.stdout.trimEnd() : "";
}

export async function captureWorkspace(runner: CommandRunner, cwd: string): Promise<WorkspaceSnapshot> {
  const [branch, head, status, workingDiff, stagedDiff, recentCommits] = await Promise.all([
    git(runner, cwd, ["branch", "--show-current"]),
    git(runner, cwd, ["rev-parse", "HEAD"]),
    git(runner, cwd, ["status", "--short", "--branch"]),
    git(runner, cwd, ["diff", "--binary"]),
    git(runner, cwd, ["diff", "--binary", "--cached"]),
    git(runner, cwd, ["log", "-10", "--oneline", "--decorate"]),
  ]);
  const diffParts = [
    stagedDiff ? "# Staged changes\n\n" + stagedDiff : "",
    workingDiff ? "# Working tree changes\n\n" + workingDiff : "",
  ].filter(Boolean);
  return {
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    status,
    diff: diffParts.join("\n\n"),
    recentCommits,
  };
}
