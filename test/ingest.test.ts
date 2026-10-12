import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import { search } from "../src/memory/retrieval.js";
import { ingestTranscript, syncTranscripts } from "../src/sources/ingest.js";
import { clearProjectCache } from "../src/store/project.js";
import { appendClaudeTurns, claudeHome, codexHome, writeClaudeSession, writeCodexSession } from "./helpers/transcripts.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "simem-ingest-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), `repo ${dir}\n`);
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearProjectCache();
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearProjectCache();
  }
}

const globalEnv = () => ({ SIMEM_STORAGE: "global", SIMEM_HOME: mkdtempSync(join(tmpdir(), "simem-ingest-home-")) });

test("a Claude app transcript is ingested incrementally: messages, deduped usage, tool events, title, rules", withSqlite, async () => {
  await withEnv(globalEnv(), async () => {
    const repo = makeRepo();
    const home = claudeHome();
    const path = writeClaudeSession(home, repo, "s-1", [
      {
        user: "Never commit generated files in dist/ to the repository.",
        messageId: "m1",
        usage: { input: 10, cacheRead: 1000, cacheWrite: 200, output: 30 },
        toolUse: { id: "t1", name: "Read", input: { file_path: join(repo, "README.md") }, result: "x".repeat(500) },
        assistant: "Understood, dist/ stays untracked.",
      },
    ]);
    writeFileSync(path, `${JSON.stringify({ type: "ai-title", sessionId: "s-1", aiTitle: "Keep dist untracked" })}\n`, { flag: "a" });

    const first = await ingestTranscript({ agent: "claude", path, sourceDir: home });
    assert.equal(first.status, "ingested");
    assert.equal(first.messages, 2);
    assert.equal((await ingestTranscript({ agent: "claude", path })).status, "unchanged");

    appendClaudeTurns(path, "s-1", repo, [
      { user: "Also run the test suite.", messageId: "m2", usage: { input: 5, cacheRead: 1500, cacheWrite: 0, output: 12 }, assistant: "All tests pass." },
    ]);
    const second = await ingestTranscript({ agent: "claude", path });
    assert.equal(second.messages, 2, "only the appended turn is read");

    const memory = await openMemoryDb(repo, { quiet: true });
    assert.ok(memory);
    try {
      const session = memory.db.prepare("SELECT agent, surface, title, model, message_count FROM sessions").get() as Record<string, unknown>;
      assert.deepEqual({ ...session }, { agent: "claude", surface: "app", title: "Keep dist untracked", model: "claude-opus-5-5", message_count: 4 });
      const usage = memory.db.prepare("SELECT COUNT(*) AS n, SUM(cache_read_tokens) AS cr FROM turn_usage").get() as { n: number; cr: number };
      assert.deepEqual({ ...usage }, { n: 2, cr: 2500 }, "usage counted once per message id despite repeated lines");
      const event = memory.db.prepare("SELECT type, tool, bytes, ok FROM events").get() as Record<string, unknown>;
      assert.deepEqual({ ...event }, { type: "read", tool: "Read", bytes: 500, ok: 1 });
      const item = memory.db.prepare("SELECT text, origin FROM memory_items").get() as { text: string; origin: string };
      assert.equal(item.origin, "rule");
      assert.match(item.text, /Never commit generated files/);
      const summary = memory.db.prepare("SELECT text FROM summaries WHERE covers_from = 'session:claude:s-1'").get() as { text: string };
      assert.match(summary.text, /^Title: Keep dist untracked/);
    } finally {
      memory.close();
    }
  });
});

test("Codex rollouts: app sessions are ingested with usage and command exit codes; simem's own exec runs are skipped", withSqlite, async () => {
  await withEnv(globalEnv(), async () => {
    const repo = makeRepo();
    const home = codexHome();
    const app = writeCodexSession(home, repo, "c-1", [
      { user: "Always use pnpm in this workspace.", command: { cmd: "pnpm test", output: "ok", exitCode: 1 }, assistant: "Tests fail on lint.", totalTokens: 5000 },
    ]);
    const internal = writeCodexSession(home, repo, "c-2", [{ user: "You are updating a persistent project memory store for a coding-agent handoff system." }], "codex_exec");
    assert.equal((await ingestTranscript({ agent: "codex", path: app })).status, "ingested");
    const skipped = await ingestTranscript({ agent: "codex", path: internal });
    assert.equal(skipped.reason, "simem internal run");

    const memory = await openMemoryDb(repo, { quiet: true });
    assert.ok(memory);
    try {
      const sessions = memory.db.prepare("SELECT id, surface FROM sessions").all() as Array<{ id: string; surface: string }>;
      assert.deepEqual(sessions.map((row) => ({ ...row })), [{ id: "session:codex:c-1", surface: "app" }]);
      const usage = memory.db.prepare("SELECT input_tokens, cache_read_tokens, output_tokens FROM turn_usage").all();
      assert.deepEqual(usage.map((row) => ({ ...row })), [{ input_tokens: 400, cache_read_tokens: 600, output_tokens: 60 }]);
      const event = memory.db.prepare("SELECT type, target, exit_code, ok FROM events").get() as Record<string, unknown>;
      assert.deepEqual({ ...event }, { type: "command", target: "pnpm test", exit_code: 1, ok: 0 });
    } finally {
      memory.close();
    }
  });
});

test("memory is shared across accounts and agents: Claude account A, Claude account B, and Codex see one store", withSqlite, async () => {
  const accountA = claudeHome();
  const accountB = claudeHome();
  const codex = codexHome();
  await withEnv({ ...globalEnv(), CLAUDE_CONFIG_DIR: accountA, CODEX_HOME: codex }, async () => {
    const repo = makeRepo();
    writeClaudeSession(accountA, repo, "a-1", [{ user: "We decided to store vectors inside memory.db instead of a separate engine.", assistant: "Noted." }]);
    writeCodexSession(codex, repo, "x-1", [{ user: "Never force-push to the release branches.", assistant: "Understood." }]);
    const summary = await syncTranscripts({ cwd: repo });
    assert.equal(summary.ingested, 2);
    assert.equal((await syncTranscripts({ cwd: repo })).ingested, 0, "a second sync is a no-op");

    // Switch "accounts": a session under account B, in a worktree, reads the same memory.
    process.env.CLAUDE_CONFIG_DIR = accountB;
    const worktree = join(realpathSync(mkdtempSync(join(tmpdir(), "simem-ingest-wt-"))), "wt");
    execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: repo });
    clearProjectCache();
    const memory = await openMemoryDb(worktree, { quiet: true });
    assert.ok(memory);
    try {
      const hits = await search(memory, "where do vectors live, memory.db or a separate engine?", { minCoverage: 0.5, minMatchedTerms: 2 });
      assert.ok(hits.some((hit) => hit.text.includes("store vectors inside memory.db")));
      const codexHits = await search(memory, "force-push release branches", { minCoverage: 0.5 });
      assert.ok(codexHits.some((hit) => hit.text.includes("Never force-push")));
    } finally {
      memory.close();
    }
  });
});

test("a rewritten transcript is re-ingested from scratch without duplicating messages", withSqlite, async () => {
  await withEnv(globalEnv(), async () => {
    const repo = makeRepo();
    const home = claudeHome();
    const path = writeClaudeSession(home, repo, "r-1", [{ user: "First version of the conversation.", assistant: "ok" }]);
    await ingestTranscript({ agent: "claude", path });
    // Same path, new content and a new inode (e.g. the app rewrote the file).
    writeClaudeSession(home, repo, "r-1", [{ user: "Rewritten conversation.", assistant: "ok" }, { user: "Second turn.", assistant: "ok" }]);
    execFileSync("cp", [path, `${path}.tmp`]);
    execFileSync("mv", [`${path}.tmp`, path]);
    await ingestTranscript({ agent: "claude", path });
    const memory = await openMemoryDb(repo, { quiet: true });
    assert.ok(memory);
    try {
      const texts = (memory.db.prepare("SELECT text FROM messages ORDER BY seq").all() as Array<{ text: string }>).map((row) => row.text);
      assert.deepEqual(texts, ["Rewritten conversation.", "ok", "Second turn.", "ok"]);
    } finally {
      memory.close();
    }
  });
});
