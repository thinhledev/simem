import { execFileSync } from "node:child_process";

// Synchronous, bounded git queries for project identity. Hooks need the
// project id before doing anything else, and these finish in milliseconds;
// any failure (not a repo, no commits, git missing) returns undefined.
function git(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    });
    const trimmed = output.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

export interface GitIdentity {
  /** Top level of this checkout or worktree. */
  toplevel: string;
  /** The shared .git directory; identical for every worktree of a repository. */
  commonDir: string;
  /** Earliest root commit: stable across clones, worktrees, machines, and renames. */
  rootCommit?: string;
  /** Normalized origin URL (no protocol, credentials, or .git suffix). */
  remote?: string;
}

export function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/:(?!\d+\/)/, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

export function gitIdentity(cwd: string): GitIdentity | undefined {
  const paths = git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (!paths) return undefined;
  const [toplevel, commonDir] = paths.split("\n");
  if (!toplevel || !commonDir) return undefined;
  const roots = git(cwd, ["rev-list", "--max-parents=0", "HEAD"]);
  const rootCommit = roots?.split("\n").sort()[0];
  const remote = git(cwd, ["config", "--get", "remote.origin.url"]);
  return {
    toplevel,
    commonDir,
    ...(rootCommit ? { rootCommit } : {}),
    ...(remote ? { remote: normalizeRemote(remote) } : {}),
  };
}
