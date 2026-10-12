import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import { ingestTranscript } from "../src/sources/ingest.js";
import { importNativeMemory, listGlobalItems, parseAutoMemory } from "../src/sources/native.js";
import { clearProjectCache } from "../src/store/project.js";
import { claudeHome, claudeSlug, codexHome, writeClaudeSession, writeCodexSession } from "./helpers/transcripts.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "simem-native-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), `repo ${dir}\n`);
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function writeAutoMemory(home: string, path: string, name: string, type: string, description: string, body: string): void {
  const dir = join(home, "projects", claudeSlug(path), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`);
  writeFileSync(join(dir, "MEMORY.md"), `- [${name}](${name}.md) — index line that must not be imported\n`);
}

test("parseAutoMemory reads frontmatter fields, including a nested metadata.type", () => {
  const parsed = parseAutoMemory("---\nname: x\ndescription: Deploys go through CI only\nmetadata: \n  type: feedback\n---\n\nBody line.\n");
  assert.deepEqual(parsed, { name: "x", description: "Deploys go through CI only", type: "feedback", body: "Body line." });
});

test("imports Claude auto-memory, routes user memories to the global store, and attaches app/Codex summaries", withSqlite, async () => {
  const accountA = claudeHome();
  const codex = codexHome();
  const desktop = mkdtempSync(join(tmpdir(), "simem-claude-desktop-"));
  const env = {
    SIMEM_STORAGE: "global",
    SIMEM_HOME: mkdtempSync(join(tmpdir(), "simem-native-home-")),
    CLAUDE_CONFIG_DIR: accountA,
    CODEX_HOME: codex,
    CLAUDE_DESKTOP_DATA_DIR: desktop,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  clearProjectCache();
  try {
    const repo = makeRepo();
    writeAutoMemory(accountA, repo, "ci-only", "feedback", "Deploys go through CI only, never from a laptop", "The user was burned by a manual deploy.");
    writeAutoMemory(accountA, repo, "founder", "user", "The user founded the company and prefers terse answers", "Background.");
    const transcript = writeClaudeSession(accountA, repo, "app-1", [{ user: "Fix the flaky upload test.", assistant: "Fixed." }]);
    await ingestTranscript({ agent: "claude", path: transcript });
    mkdirSync(join(desktop, "claude-code-sessions", "acct", "x"), { recursive: true });
    writeFileSync(
      join(desktop, "claude-code-sessions", "acct", "x", "local.json"),
      JSON.stringify({ cliSessionId: "app-1", originCwd: repo, title: "Flaky upload test", postTurnSummary: { status_detail: "Upload test fixed by awaiting the stream", needs_action: "" } }),
    );
    const rollout = writeCodexSession(codex, repo, "th-1", [{ user: "Tidy the logging.", assistant: "Done." }]);
    await ingestTranscript({ agent: "codex", path: rollout });
    const sqliteModule = await loadSqlite();
    const codexDb = new sqliteModule!.DatabaseSync(join(codex, "memories_1.sqlite"));
    codexDb.exec("CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL)");
    codexDb.prepare("INSERT INTO stage1_outputs VALUES ('th-1', ?, ?)").run("- Logging uses pino with JSON output in production.", "Tidied logging to pino.");
    codexDb.close();

    const summary = await importNativeMemory(repo);
    assert.equal(summary.autoMemoryItems, 1);
    assert.equal(summary.globalItems, 1);
    assert.equal(summary.appSummaries, 1);
    assert.equal(summary.codexSummaries, 1);
    assert.deepEqual(await importNativeMemory(repo), { autoMemoryItems: 0, globalItems: 0, appSummaries: 0, codexSummaries: 0 }, "re-import is a no-op");

    const memory = await openMemoryDb(repo, { quiet: true });
    assert.ok(memory);
    try {
      const items = (memory.db.prepare("SELECT text, origin FROM memory_items ORDER BY id").all() as Array<{ text: string; origin: string }>).map((row) => ({ ...row }));
      assert.ok(items.some((item) => item.origin === "import" && item.text.startsWith("Deploys go through CI only")));
      assert.ok(items.some((item) => item.text === "Logging uses pino with JSON output in production."));
      assert.ok(!items.some((item) => item.text.includes("index line")), "MEMORY.md is an index, not a memory");
      const app = memory.db.prepare("SELECT title, app_summary FROM sessions WHERE id = 'session:claude:app-1'").get() as Record<string, string>;
      assert.deepEqual({ ...app }, { title: "Flaky upload test", app_summary: "Upload test fixed by awaiting the stream" });
    } finally {
      memory.close();
    }
    assert.ok(listGlobalItems().some((item) => item.text.startsWith("The user founded the company")));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearProjectCache();
  }
});
