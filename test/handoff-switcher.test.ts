import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareSwitch } from "../src/handoff/switcher.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/process.js";

async function seedCodexSession(root: string, workspace: string): Promise<void> {
  const codexDir = join(root, "codex", "sessions", "2026", "07", "02");
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    join(codexDir, "codex.jsonl"),
    [
      { type: "session_meta", payload: { session_id: "codex-1", cwd: workspace } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Finish phase one" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"),
  );
}

class EmptyGitRunner implements CommandRunner {
  async run(_spec: CommandSpec): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
  }
}

test("prepares a token-free Codex to Claude resume and a native fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "simem-switch-"));
  const workspace = join(root, "workspace");
  const claudeDir = join(root, "claude", "projects", "project");
  await mkdir(workspace, { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  await seedCodexSession(root, workspace);
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

test("resumes Cursor over its CLI and opens Cursor Desktop on the project folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "simem-switch-cursor-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await seedCodexSession(root, workspace);

  const previousCodex = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  try {
    const interactive = await prepareSwitch(new EmptyGitRunner(), {
      cwd: workspace,
      source: "codex",
      target: "cursor",
      surface: "interactive",
    });
    assert.equal(interactive.command, "cursor-agent");
    assert.deepEqual(interactive.args, [interactive.prompt]);

    if (process.platform === "darwin") {
      const desktop = await prepareSwitch(new EmptyGitRunner(), {
        cwd: workspace,
        source: "codex",
        target: "cursor",
        surface: "desktop",
      });
      assert.equal(desktop.command, "open");
      assert.deepEqual(desktop.args, ["-a", "Cursor", workspace]);
    }
  } finally {
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
  }
});

test("resumes Antigravity through the agy CLI and starts fresh with --new", async () => {
  const root = await mkdtemp(join(tmpdir(), "simem-switch-antigravity-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await seedCodexSession(root, workspace);

  const previousCodex = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  try {
    const resume = await prepareSwitch(new EmptyGitRunner(), {
      cwd: workspace,
      source: "codex",
      target: "antigravity",
      surface: "interactive",
    });
    assert.equal(resume.command, "agy");
    assert.deepEqual(resume.args, ["--continue", "-i", resume.prompt]);

    const fresh = await prepareSwitch(new EmptyGitRunner(), {
      cwd: workspace,
      source: "codex",
      target: "antigravity",
      surface: "interactive",
      newSession: true,
    });
    assert.deepEqual(fresh.args, ["--new-project", "-i", fresh.prompt]);
  } finally {
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
  }
});

if (process.platform === "darwin") {
  test("opens Antigravity Desktop without a preselected folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "simem-switch-antigravity-desktop-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await seedCodexSession(root, workspace);

    const previousCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, "codex");
    try {
      const desktop = await prepareSwitch(new EmptyGitRunner(), {
        cwd: workspace,
        source: "codex",
        target: "antigravity",
        surface: "desktop",
      });
      assert.equal(desktop.command, "open");
      assert.deepEqual(desktop.args, ["-a", "Antigravity"]);
      assert.equal(desktop.claudeMemory, undefined);
    } finally {
      if (previousCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodex;
    }
  });
}
