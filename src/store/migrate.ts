import { closeSync, cpSync, existsSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "./home.js";
import type { ProjectRef } from "./project.js";
import { loadSqliteSync } from "./sqlite.js";

export type MigrationOutcome = "migrated" | "none" | "busy";

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 5_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function acquireLock(path: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) unlinkSync(path);
      } catch {
        // Lock vanished between checks; retry.
      }
      if (Date.now() > deadline) return false;
      sleep(50);
    }
  }
}

// One-time move of a 1.x in-repo store (<repo>/.mixai/memory.db, checkpoints/,
// current/, state.json) into the global per-project store. Copy-first: the
// database is copied with VACUUM INTO (consistent even with a live WAL),
// renamed into place atomically, and only then is the old file renamed to
// memory.db.bak-1x. The repo's .mixai/current/ is left in place so a 1.x
// CLAUDE.local.md @import keeps resolving. Concurrent callers wait on a lock.
export function migrateLegacyStore(ref: ProjectRef): MigrationOutcome {
  if (ref.mode !== "global") return "none";
  const legacyDir = join(ref.root, ".mixai");
  const legacyDb = join(legacyDir, "memory.db");
  const target = join(ref.storeDir, "memory.db");
  if (!existsSync(legacyDb) || existsSync(target)) return "none";
  const sqlite = loadSqliteSync();
  if (!sqlite) return "none";
  ensurePrivateDir(ref.storeDir);
  const lock = join(ref.storeDir, "migrate.lock");
  if (!acquireLock(lock)) return "busy";
  try {
    // Another process may have finished while we waited.
    if (existsSync(target) || !existsSync(legacyDb)) return "none";
    const staging = join(ref.storeDir, "memory.db.migrating");
    if (existsSync(staging)) unlinkSync(staging);
    const legacy = new sqlite.DatabaseSync(legacyDb);
    try {
      legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      legacy.exec(`VACUUM INTO ${sqlString(staging)}`);
    } finally {
      legacy.close();
    }
    for (const name of ["checkpoints", "current", "state.json", "CURRENT.md"]) {
      const source = join(legacyDir, name);
      if (existsSync(source)) cpSync(source, join(ref.storeDir, name), { recursive: true, force: false, errorOnExist: false });
    }
    const staged = new sqlite.DatabaseSync(staging);
    try {
      staged
        .prepare("UPDATE checkpoints SET directory = ? || substr(directory, ?) WHERE substr(directory, 1, ?) = ?")
        .run(ref.storeDir, legacyDir.length + 1, legacyDir.length, legacyDir);
    } finally {
      staged.close();
    }
    renameSync(staging, target);
    renameSync(legacyDb, `${legacyDb}.bak-1x`);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        unlinkSync(`${legacyDb}${suffix}`);
      } catch {
        // Already gone after the TRUNCATE checkpoint.
      }
    }
    writeFileSync(
      join(legacyDir, "MIGRATED.txt"),
      `mixai 2.0 moved this project's memory to ${ref.storeDir}.\n` +
        "The previous database is kept as memory.db.bak-1x. Run `mixai migrate --to project` to move it back.\n",
      "utf8",
    );
    return "migrated";
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Best-effort.
    }
  }
}

// Reverse migration: copies the global store back into <repo>/.mixai and
// marks the project as repo-local, so this project uses the 1.x layout again.
export function migrateToProject(ref: ProjectRef): string {
  const sqlite = loadSqliteSync();
  if (!sqlite) throw new Error("Migration requires node:sqlite (Node.js >= 22.5)");
  const legacyDir = ensurePrivateDir(join(ref.root, ".mixai"));
  const source = join(ref.storeDir, "memory.db");
  const target = join(legacyDir, "memory.db");
  if (!existsSync(source)) throw new Error(`No global store for this project at ${ref.storeDir}`);
  if (existsSync(target)) renameSync(target, `${target}.bak-${Date.now()}`);
  const db = new sqlite.DatabaseSync(source);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec(`VACUUM INTO ${sqlString(target)}`);
  } finally {
    db.close();
  }
  for (const name of ["checkpoints", "current", "state.json"]) {
    const from = join(ref.storeDir, name);
    if (existsSync(from)) cpSync(from, join(legacyDir, name), { recursive: true, force: true });
  }
  const copied = new sqlite.DatabaseSync(target);
  try {
    copied
      .prepare("UPDATE checkpoints SET directory = ? || substr(directory, ?) WHERE substr(directory, 1, ?) = ?")
      .run(legacyDir, ref.storeDir.length + 1, ref.storeDir.length, ref.storeDir);
  } finally {
    copied.close();
  }
  writeFileSync(join(legacyDir, "project-local"), "This project keeps its mixai memory in this directory.\n", "utf8");
  return target;
}
