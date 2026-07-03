import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareSwitch } from "../src/handoff/switcher.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/process.js";

class EmptyGitRunner implements CommandRunner {
  async run(_spec: CommandSpec): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
  }
}

test("prepares a token-free Codex to Claude resume and a native fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "cag-switch-"));
  const workspace = join(root, "workspace");
  const codexDir = join(root, "codex", "sessions", "2026", "07", "02");
  const claudeDir = join(root, "claude", "projects", "project");
  await mkdir(workspace, { recursive: true });
  await mkdir(codexDir, { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  await writeFile(
    join(codexDir, "codex.jsonl"),
    [
      { type: "session_meta", payload: { session_id: "codex-1", cwd: workspace } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Finish phase one" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"),
  );
  await writeFile(
    join(claudeDir, "claude.jsonl"),
    JSON.stringify({ type: "user", sessionId: "claude-1", cwd: workspace, message: { role: "user", content: "Earlier work" } }),
  );

  const previousCodex = process.env.CODEX_HOME;
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  try {
    const resume = await prepareSwitch(new EmptyGitRunner(), {
      cwd: workspace,
      source: "codex",
      target: "claude",
      surface: "interactive",
    });
    assert.equal(resume.command, "claude");
    assert.deepEqual(resume.args.slice(0, 2), ["--resume", "claude-1"]);
    assert.match(resume.prompt, /Read .*HANDOFF\.md first/);
    assert.equal(resume.checkpoint.manifest.target?.sessionId, "claude-1");

    const fork = await prepareSwitch(new EmptyGitRunner(), {
      cwd: workspace,
      source: "codex",
      target: "claude",
      fork: true,
      surface: "interactive",
    });
    assert.ok(fork.args.includes("--fork-session"));
    assert.equal(fork.checkpoint.manifest.lineage.parentCheckpointId, resume.checkpoint.manifest.id);

    if (process.platform === "darwin") {
      const desktop = await prepareSwitch(new EmptyGitRunner(), {
        cwd: workspace,
        source: "codex",
        target: "claude",
        surface: "desktop",
        newSession: true,
      });
      assert.equal(desktop.command, "open");
      assert.deepEqual(desktop.args, ["-a", "Claude"]);
      assert.equal(desktop.claudeMemory?.memoryPath, join(workspace, "CLAUDE.local.md"));
    }
  } finally {
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  }
});
