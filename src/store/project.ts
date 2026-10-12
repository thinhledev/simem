import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gitIdentity, type GitIdentity } from "./git.js";
import { openGlobalDb } from "./global-db.js";
import { ensurePrivateDir, simemHome, storageMode, type StorageMode } from "./home.js";

export interface ProjectRef {
  id: string;
  name: string;
  /** Checkout (or worktree) root the cwd belongs to; the cwd itself outside git. */
  root: string;
  /** Where this project's memory, checkpoints, and state live. */
  storeDir: string;
  mode: StorageMode;
  /** Which key identified the project: pin, root commit, remote, or path. */
  identifiedBy: "pin" | "root" | "remote" | "path";
  git?: GitIdentity;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// Identity keys in priority order. The root commit is shared by every clone
// and worktree of a repository, so it is the primary key; the remote catches
// a shallow clone or re-initialized history; the path is the fallback.
function identityKeys(root: string, identity: GitIdentity | undefined): Array<{ key: string; kind: ProjectRef["identifiedBy"] }> {
  const keys: Array<{ key: string; kind: ProjectRef["identifiedBy"] }> = [];
  if (identity?.rootCommit) keys.push({ key: `root:${identity.rootCommit}`, kind: "root" });
  if (identity?.remote) keys.push({ key: `remote:${identity.remote}`, kind: "remote" });
  keys.push({ key: `path:${identity ? realpath(identity.commonDir) : root}`, kind: "path" });
  return keys;
}

function idFor(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// An explicit pin (`<root>/.simem/project.json` with { "projectId": "…" })
// beats everything; `simem project link` writes it for the main checkout.
function pinnedId(root: string): string | undefined {
  try {
    const pin = JSON.parse(readFileSync(join(root, ".simem", "project.json"), "utf8")) as { projectId?: unknown };
    return typeof pin.projectId === "string" && /^[\w-]{4,64}$/.test(pin.projectId) ? pin.projectId : undefined;
  } catch {
    return undefined;
  }
}

// A per-project opt-out of the global store (`simem migrate --to project`).
export function projectLocalMarker(root: string): string {
  return join(root, ".simem", "project-local");
}

function lookupOrRegister(
  db: DatabaseSync,
  pathKey: string,
  root: string,
  keys: Array<{ key: string; kind: ProjectRef["identifiedBy"] }>,
): { id: string; kind: ProjectRef["identifiedBy"] } {
  const now = new Date().toISOString();
  const findKey = db.prepare("SELECT project_id FROM project_keys WHERE key = ?");
  for (const { key, kind } of keys) {
    const row = findKey.get(key) as { project_id: string } | undefined;
    if (row) {
      // Teach the registry this project's other keys and this path.
      const addKey = db.prepare("INSERT OR IGNORE INTO project_keys (key, project_id) VALUES (?, ?)");
      for (const other of keys) addKey.run(other.key, row.project_id);
      db.prepare(
        "INSERT INTO project_paths (path, project_id, last_seen) VALUES (?, ?, ?) " +
          "ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, last_seen = excluded.last_seen",
      ).run(pathKey, row.project_id, now);
      return { id: row.project_id, kind };
    }
  }
  const first = keys[0]!;
  const id = idFor(first.key);
  db.prepare("INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(id, basename(root), now);
  const addKey = db.prepare("INSERT OR IGNORE INTO project_keys (key, project_id) VALUES (?, ?)");
  for (const { key } of keys) addKey.run(key, id);
  db.prepare(
    "INSERT INTO project_paths (path, project_id, last_seen) VALUES (?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, last_seen = excluded.last_seen",
  ).run(pathKey, id, now);
  return { id, kind: first.kind };
}

const resolved = new Map<string, ProjectRef>();

// Resolves the project a directory belongs to. In `global` mode the result is
// memoized per process and cached by path in global.db, so a hook only pays
// for git calls the first time a path is seen.
export function resolveProject(cwd: string): ProjectRef {
  const absolute = resolve(cwd);
  const mode = storageMode();
  const memoKey = `${mode}:${absolute}`;
  const memo = resolved.get(memoKey);
  if (memo) return memo;

  if (mode === "project") {
    const ref: ProjectRef = {
      id: idFor(`path:${realpath(absolute)}`),
      name: basename(absolute),
      root: absolute,
      storeDir: join(absolute, ".simem"),
      mode,
      identifiedBy: "path",
    };
    resolved.set(memoKey, ref);
    return ref;
  }

  const identity = gitIdentity(absolute);
  const root = identity ? realpath(identity.toplevel) : realpath(absolute);
  if (existsSync(projectLocalMarker(root))) {
    const ref: ProjectRef = {
      id: idFor(`path:${root}`),
      name: basename(root),
      root,
      storeDir: join(root, ".simem"),
      mode: "project",
      identifiedBy: "path",
      ...(identity ? { git: identity } : {}),
    };
    resolved.set(memoKey, ref);
    return ref;
  }

  const pin = pinnedId(root);
  let id: string;
  let identifiedBy: ProjectRef["identifiedBy"];
  if (pin) {
    id = pin;
    identifiedBy = "pin";
  } else {
    const keys = identityKeys(root, identity);
    const db = openGlobalDb();
    if (db) {
      try {
        ({ id, kind: identifiedBy } = lookupOrRegister(db, root, root, keys));
      } finally {
        db.close();
      }
    } else {
      id = idFor(keys[0]!.key);
      identifiedBy = keys[0]!.kind;
    }
  }
  const ref: ProjectRef = {
    id,
    name: basename(root),
    root,
    storeDir: join(simemHome(), "projects", id),
    mode,
    identifiedBy,
    ...(identity ? { git: identity } : {}),
  };
  resolved.set(memoKey, ref);
  return ref;
}

/** Forget memoized resolutions (tests, and after link/unlink). */
export function clearProjectCache(): void {
  resolved.clear();
}

export function projectStoreDir(cwd: string): string {
  const { storeDir, mode } = resolveProject(cwd);
  return mode === "global" ? ensurePrivateDir(storeDir) : storeDir;
}

export interface ProjectListing {
  id: string;
  name: string;
  paths: string[];
  keys: string[];
}

export function listProjects(): ProjectListing[] {
  const db = openGlobalDb();
  if (!db) return [];
  try {
    const projects = db.prepare("SELECT id, name FROM projects ORDER BY created_at").all() as Array<{ id: string; name: string }>;
    return projects.map((project) => ({
      ...project,
      paths: (db.prepare("SELECT path FROM project_paths WHERE project_id = ? ORDER BY last_seen DESC").all(project.id) as Array<{ path: string }>).map((row) => row.path),
      keys: (db.prepare("SELECT key FROM project_keys WHERE project_id = ? ORDER BY key").all(project.id) as Array<{ key: string }>).map((row) => row.key),
    }));
  } finally {
    db.close();
  }
}

// Points this checkout's identity keys at another project's id, merging the
// two identities going forward (e.g. a re-initialized repository). Existing
// memory in the old store is not moved; `simem memory export/import` does that.
export function linkProject(cwd: string, targetId: string): ProjectRef {
  const db = openGlobalDb();
  if (!db) throw new Error("Linking projects requires node:sqlite (Node.js >= 22.5)");
  try {
    const target = db.prepare("SELECT id FROM projects WHERE id = ?").get(targetId);
    if (!target) throw new Error(`No project with id ${targetId}; see \`simem project list\``);
    const identity = gitIdentity(cwd);
    const root = identity ? realpath(identity.toplevel) : realpath(cwd);
    const now = new Date().toISOString();
    for (const { key } of identityKeys(root, identity)) {
      db.prepare(
        "INSERT INTO project_keys (key, project_id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET project_id = excluded.project_id",
      ).run(key, targetId);
    }
    db.prepare(
      "INSERT INTO project_paths (path, project_id, last_seen) VALUES (?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, last_seen = excluded.last_seen",
    ).run(root, targetId, now);
  } finally {
    db.close();
  }
  clearProjectCache();
  return resolveProject(cwd);
}

// Splits this checkout into its own project (e.g. a fork that shares a root
// commit with upstream but should not share memory). Keyed by path from now on.
export function unlinkProject(cwd: string): ProjectRef {
  const db = openGlobalDb();
  if (!db) throw new Error("Unlinking projects requires node:sqlite (Node.js >= 22.5)");
  const identity = gitIdentity(cwd);
  const root = identity ? realpath(identity.toplevel) : realpath(cwd);
  try {
    const pathKey = `path:${root}`;
    const id = idFor(`unlinked:${root}`);
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(id, basename(root), now);
    db.prepare(
      "INSERT INTO project_keys (key, project_id) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET project_id = excluded.project_id",
    ).run(pathKey, id);
    db.prepare(
      "INSERT INTO project_paths (path, project_id, last_seen) VALUES (?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, last_seen = excluded.last_seen",
    ).run(root, id, now);
  } finally {
    db.close();
  }
  // A path-keyed project must not be re-captured by the shared root commit,
  // so pin it explicitly.
  writePin(root, idFor(`unlinked:${root}`));
  clearProjectCache();
  return resolveProject(cwd);
}

function writePin(root: string, projectId: string): void {
  writeFileSync(join(ensurePrivateDir(join(root, ".simem")), "project.json"), `${JSON.stringify({ projectId }, null, 2)}\n`, "utf8");
}

export function projectsRoot(): string {
  return join(simemHome(), "projects");
}

export function storeDirFor(projectId: string): string {
  return join(projectsRoot(), projectId);
}
