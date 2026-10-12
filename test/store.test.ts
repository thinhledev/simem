import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import { normalizeRemote } from "../src/store/git.js";
import { migrateToProject } from "../src/store/migrate.js";
import { clearProjectCache, linkProject, listProjects, resolveProject, unlinkProject } from "../src/store/project.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mixai-store-repo-")));
  git(dir, "init", "-q");
  // Unique content: root commits are content-addressed, so two repos with an
  // identical first commit (same tree, author, message, and second) really
  // are the same root — the fork case `project unlink` exists for.
  writeFileSync(join(dir, "README.md"), `hello ${dir}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

async function inGlobalMode<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.MIXAI_STORAGE;
  const previousHome = process.env.MIXAI_HOME;
  process.env.MIXAI_STORAGE = "global";
  process.env.MIXAI_HOME = mkdtempSync(join(tmpdir(), "mixai-store-home-"));
  clearProjectCache();
  try {
    return await fn();
  } finally {
    process.env.MIXAI_STORAGE = previous;
    process.env.MIXAI_HOME = previousHome;
    clearProjectCache();
  }
}

test("normalizeRemote strips protocol, credentials, scp syntax, and .git", () => {
  assert.equal(normalizeRemote("git@github.com:Org/Repo.git"), "github.com/org/repo");
  assert.equal(normalizeRemote("https://user:token@github.com/Org/Repo.git/"), "github.com/org/repo");
  assert.equal(normalizeRemote("ssh://git@host:2222/org/repo.git"), "host:2222/org/repo");
});

test("a worktree and a clone of the same repository share one global store", withSqlite, async () => {
  await inGlobalMode(() => {
    const repo = makeRepo();
    const main = resolveProject(repo);
    assert.equal(main.mode, "global");
    assert.equal(main.identifiedBy, "root");
    assert.equal(main.storeDir, join(process.env.MIXAI_HOME!, "projects", main.id));

    const worktree = join(realpathSync(mkdtempSync(join(tmpdir(), "mixai-store-wt-"))), "wt");
    git(repo, "worktree", "add", "-q", worktree);
    assert.equal(resolveProject(worktree).id, main.id);
    assert.equal(resolveProject(join(worktree)).root, worktree);

    const clone = join(realpathSync(mkdtempSync(join(tmpdir(), "mixai-store-clone-"))), "c");
    execFileSync("git", ["clone", "-q", repo, clone]);
    assert.equal(resolveProject(clone).id, main.id);

    const listed = listProjects().find((project) => project.id === main.id);
    assert.ok(listed);
    assert.ok(listed.paths.includes(clone));
  });
});

test("a non-git directory gets its own path-keyed project; unrelated repos never collide", withSqlite, async () => {
  await inGlobalMode(() => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "mixai-store-plain-")));
    const ref = resolveProject(plain);
    assert.equal(ref.identifiedBy, "path");
    assert.notEqual(resolveProject(makeRepo()).id, resolveProject(makeRepo()).id);
    assert.notEqual(ref.id, resolveProject(makeRepo()).id);
  });
});

test("unlink splits a fork into its own project; link merges it back", withSqlite, async () => {
  await inGlobalMode(() => {
    const upstream = makeRepo();
    const fork = join(realpathSync(mkdtempSync(join(tmpdir(), "mixai-store-fork-"))), "f");
    execFileSync("git", ["clone", "-q", upstream, fork]);
    const shared = resolveProject(upstream).id;
    assert.equal(resolveProject(fork).id, shared);

    const split = unlinkProject(fork);
    assert.notEqual(split.id, shared);
    assert.equal(split.identifiedBy, "pin");
    clearProjectCache();
    assert.equal(resolveProject(upstream).id, shared, "upstream keeps its identity");

    // link writes registry keys; the pin from unlink still wins until removed.
    const relinked = linkProject(upstream, split.id);
    assert.equal(relinked.id, split.id);
  });
});

test("a 1.x in-repo store migrates into the global store once, and migrates back on request", withSqlite, async () => {
  const repo = makeRepo();
  // Build a 1.x store in project mode.
  const legacy = await openMemoryDb(repo, { quiet: true });
  assert.ok(legacy);
  legacy.db
    .prepare(
      "INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) VALUES ('cp-1', '2026-07-01T00:00:00Z', ?, 'codex', 's', 'export', ?, '{}')",
    )
    .run(repo, join(repo, ".mixai", "checkpoints", "cp-1"));
  legacy.db
    .prepare("INSERT INTO memory_items (kind, text, importance, created_at, last_reinforced_at) VALUES ('semantic', 'Never use dependency X.', 9, 't', 't')")
    .run();
  legacy.close();
  mkdirSync(join(repo, ".mixai", "checkpoints", "cp-1"), { recursive: true });
  writeFileSync(join(repo, ".mixai", "checkpoints", "cp-1", "manifest.json"), "{}");

  await inGlobalMode(async () => {
    const ref = resolveProject(repo);
    const migrated = await openMemoryDb(repo, { quiet: true });
    assert.ok(migrated);
    try {
      assert.equal(migrated.path, join(ref.storeDir, "memory.db"));
      const item = migrated.db.prepare("SELECT text FROM memory_items").get() as { text: string };
      assert.equal(item.text, "Never use dependency X.");
      const checkpoint = migrated.db.prepare("SELECT directory FROM checkpoints WHERE id = 'cp-1'").get() as { directory: string };
      assert.equal(checkpoint.directory, join(ref.storeDir, "checkpoints", "cp-1"));
    } finally {
      migrated.close();
    }
    assert.ok(existsSync(join(ref.storeDir, "checkpoints", "cp-1", "manifest.json")));
    assert.ok(existsSync(join(repo, ".mixai", "memory.db.bak-1x")));
    assert.ok(!existsSync(join(repo, ".mixai", "memory.db")));
    assert.ok(existsSync(join(repo, ".mixai", "MIGRATED.txt")));

    // Opening again is a no-op (no second migration, same data).
    const again = await openMemoryDb(repo, { quiet: true });
    assert.ok(again);
    again.close();

    const back = migrateToProject(ref);
    assert.equal(back, join(repo, ".mixai", "memory.db"));
    clearProjectCache();
    const local = resolveProject(repo);
    assert.equal(local.mode, "project", "the project-local marker opts this repo out of the global store");
    const reopened = await openMemoryDb(repo, { quiet: true });
    assert.ok(reopened);
    try {
      assert.equal(reopened.path, join(repo, ".mixai", "memory.db"));
      const count = reopened.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number };
      assert.equal(count.n, 1);
    } finally {
      reopened.close();
    }
  });
});
