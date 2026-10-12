import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, type GatewayConfig } from "../src/config.js";
import { handleSessionStart, handleUserPromptSubmit } from "../src/handoff/hooks.js";
import { loadSqlite } from "../src/memory/db.js";
import type { CommandResult, CommandRunner } from "../src/process.js";
import { ingestTranscript } from "../src/sources/ingest.js";
import { clearProjectCache } from "../src/store/project.js";
import { claudeHome, writeClaudeSession } from "./helpers/transcripts.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

const runner: CommandRunner = {
  async run(): Promise<CommandResult> {
    return { exitCode: 0, stdout: "## main\n", stderr: "", durationMs: 1, timedOut: false };
  },
};

const config: GatewayConfig = {
  ...DEFAULT_CONFIG,
  memory: { ...DEFAULT_CONFIG.memory, embeddings: { ...DEFAULT_CONFIG.memory.embeddings, enabled: false } },
};

async function project(): Promise<string> {
  process.env.SIMEM_STORAGE = "global";
  process.env.SIMEM_HOME = mkdtempSync(join(tmpdir(), "simem-primer-home-"));
  clearProjectCache();
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "simem-primer-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), `x ${repo}\n`);
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "i"], { cwd: repo });
  const home = claudeHome();
  const transcript = writeClaudeSession(home, repo, "claude-1", [
    { user: "Never commit directly to master; every change goes through a pull request.", assistant: "Understood." },
    { toolUse: { id: "b1", name: "Bash", input: { command: "npm test 2>&1 | tail -5" }, result: "ok" }, assistant: "All 42 tests pass." },
    { user: "Fix the flaky upload test.", assistant: "Fixed by awaiting the stream before asserting. Implemented in src/upload.ts." },
  ]);
  await ingestTranscript({ agent: "claude", path: transcript });
  return repo;
}

test("a new Codex session starts with Claude's latest work, standing rules, and known commands — byte-stable", withSqlite, async () => {
  const previous = { storage: process.env.SIMEM_STORAGE, home: process.env.SIMEM_HOME };
  try {
    const repo = await project();
    const primer = await handleSessionStart({ source: "startup", sessionId: "codex-new" }, repo, "codex", config, runner);
    assert.match(primer, /^## Project memory: /);
    assert.match(primer, /### Latest work \(claude app, 2026-10-12\)/);
    assert.match(primer, /Fix the flaky upload test/);
    assert.match(primer, /Never commit directly to master/);
    assert.match(primer, /`npm test`/);
    assert.ok(primer.length <= DEFAULT_CONFIG.memory.hooks.briefMaxChars + 2);
    const again = await handleSessionStart({ source: "startup", sessionId: "codex-new-2" }, repo, "codex", config, runner);
    assert.equal(again, primer, "same memory, same bytes (prompt-cache friendly)");
  } finally {
    process.env.SIMEM_STORAGE = previous.storage;
    process.env.SIMEM_HOME = previous.home;
    clearProjectCache();
  }
});

test("per-prompt injection skips what the primer already showed, until the context is compacted", withSqlite, async () => {
  const previous = { storage: process.env.SIMEM_STORAGE, home: process.env.SIMEM_HOME };
  try {
    const repo = await project();
    const prompt = { prompt: "can I commit directly to master or do I need a pull request?", sessionId: "s-dedupe" };
    await handleSessionStart({ source: "startup", sessionId: "s-dedupe" }, repo, "claude", config, runner);
    assert.equal(await handleUserPromptSubmit(prompt, repo, "claude", config), "", "already in this session's context");
    assert.match(await handleUserPromptSubmit({ ...prompt, sessionId: "other" }, repo, "claude", config), /Never commit directly to master/);
    assert.equal(await handleUserPromptSubmit({ ...prompt, sessionId: "other" }, repo, "claude", config), "", "never twice in one session");
    await handleSessionStart({ source: "compact", sessionId: "other" }, repo, "claude", config, runner);
    assert.match(await handleUserPromptSubmit({ ...prompt, sessionId: "other" }, repo, "claude", config), /Never commit directly to master/, "compaction emptied the context");
  } finally {
    process.env.SIMEM_STORAGE = previous.storage;
    process.env.SIMEM_HOME = previous.home;
    clearProjectCache();
  }
});
