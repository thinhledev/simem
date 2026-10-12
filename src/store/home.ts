import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Everything mixai keeps across projects, accounts, and agents lives under
// one directory owned by the user: per-project memory stores, the project
// registry (global.db), the pinned launcher, models, and global config.
export function mixaiHome(): string {
  return resolve(process.env.MIXAI_HOME ?? join(homedir(), ".mixai"));
}

// Owner-only permissions: the store holds transcripts from every agent account.
export function ensurePrivateDir(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best-effort on filesystems without POSIX modes.
  }
  return path;
}

export function globalConfigPath(): string {
  return join(mixaiHome(), "config.json");
}

export type StorageMode = "global" | "project";

// Where project memory lives. `global` (default) keeps each project's store
// under ~/.mixai/projects/<id>, shared by every checkout, worktree, agent,
// and account. `project` keeps the 1.x layout inside the repo's .mixai/.
// MIXAI_STORAGE beats ~/.mixai/config.json's memory.storage.
export function storageMode(): StorageMode {
  const fromEnv = process.env.MIXAI_STORAGE;
  if (fromEnv === "global" || fromEnv === "project") return fromEnv;
  try {
    const raw = JSON.parse(readFileSync(globalConfigPath(), "utf8")) as { memory?: { storage?: unknown } };
    if (raw.memory?.storage === "project") return "project";
  } catch {
    // No global config (or unreadable): use the default.
  }
  return "global";
}
