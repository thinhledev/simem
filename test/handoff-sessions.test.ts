import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverSessions, extractTranscript, resolveSession } from "../src/handoff/sessions.js";

test("discovers a Codex Desktop session by workspace and extracts human conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "cag-codex-"));
  const workspace = join(root, "workspace");
  const sessions = join(root, "codex", "sessions", "2026", "07", "02");
  await mkdir(workspace, { recursive: true });
  await mkdir(sessions, { recursive: true });
  const path = join(sessions, "rollout.jsonl");
  await writeFile(
    path,
    [
      { type: "session_meta", payload: { session_id: "codex-1", cwd: workspace, originator: "Codex Desktop", timestamp: "2026-07-02T00:00:00Z" } },
      { type: "response_item", timestamp: "2026-07-02T00:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>injected</environment_context>" }] } },
      { type: "response_item", timestamp: "2026-07-02T00:02:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the gateway" }] } },
      { type: "response_item", timestamp: "2026-07-02T00:03:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Implemented the fix" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"),
  );

  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  try {
    const found = await discoverSessions("codex", workspace);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.id, "codex-1");
    assert.equal(found[0]?.origin, "Codex Desktop");
    const messages = await extractTranscript(found[0]!);
    assert.deepEqual(messages.map((message) => [message.role, message.text]), [
      ["user", "Fix the gateway"],
      ["assistant", "Implemented the fix"],
    ]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("discovers and resolves Claude sessions by their local session id", async () => {
  const root = await mkdtemp(join(tmpdir(), "cag-claude-"));
  const workspace = join(root, "workspace");
  const projects = join(root, "claude", "projects", "project");
  await mkdir(workspace, { recursive: true });
  await mkdir(projects, { recursive: true });
  await writeFile(
    join(projects, "claude-1.jsonl"),
    [
      { type: "user", sessionId: "claude-1", cwd: workspace, timestamp: "2026-07-02T00:00:00Z", message: { role: "user", content: "Continue the work" } },
      { type: "assistant", sessionId: "claude-1", cwd: workspace, timestamp: "2026-07-02T00:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"),
  );

  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  try {
    const session = await resolveSession("claude", workspace, "claude-1");
    assert.equal(session.id, "claude-1");
    assert.deepEqual((await extractTranscript(session)).map((message) => message.text), ["Continue the work", "Done"]);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("maps a Claude Code Desktop worktree transcript back to its original project", async () => {
  const root = await mkdtemp(join(tmpdir(), "cag-claude-desktop-"));
  const workspace = join(root, "workspace");
  const worktree = join(workspace, ".claude", "worktrees", "session");
  const projects = join(root, "claude", "projects", "project");
  const desktopSessions = join(root, "desktop", "claude-code-sessions", "account", "org");
  await mkdir(worktree, { recursive: true });
  await mkdir(projects, { recursive: true });
  await mkdir(desktopSessions, { recursive: true });
  await writeFile(
    join(projects, "desktop-cli-id.jsonl"),
    JSON.stringify({
      type: "user",
      sessionId: "desktop-cli-id",
      cwd: worktree,
      message: { role: "user", content: "Desktop task" },
    }),
  );
  await writeFile(
    join(desktopSessions, "local-desktop-id.json"),
    JSON.stringify({ sessionId: "local-desktop-id", cliSessionId: "desktop-cli-id", cwd: worktree, originCwd: workspace }),
  );

  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  const previousDesktop = process.env.CLAUDE_DESKTOP_DATA_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CLAUDE_DESKTOP_DATA_DIR = join(root, "desktop");
  try {
    const sessions = await discoverSessions("claude", workspace);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, "desktop-cli-id");
    assert.equal(sessions[0]?.cwd, workspace);
    assert.equal(sessions[0]?.origin, "Claude Code Desktop");
  } finally {
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    if (previousDesktop === undefined) delete process.env.CLAUDE_DESKTOP_DATA_DIR;
    else process.env.CLAUDE_DESKTOP_DATA_DIR = previousDesktop;
  }
});
