import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createCheckpoint, readGatewayState } from "../src/handoff/checkpoints.js";
import type { SessionInfo } from "../src/handoff/types.js";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/process.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

class GitRunner implements CommandRunner {
  async run(spec: CommandSpec): Promise<CommandResult> {
    const args = spec.args ?? [];
    let stdout = "";
    if (args[0] === "branch") stdout = "main\n";
    else if (args[0] === "rev-parse") stdout = "abc123\n";
    else if (args[0] === "status") stdout = "## main\n M src/app.ts\n?? notes.txt\n";
    else if (args[0] === "diff" && args.includes("--cached")) stdout = "staged patch\n";
    else if (args[0] === "diff") stdout = "working patch\n";
    else if (args[0] === "log") stdout = "abc123 latest\n";
    return { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false };
  }
}

test("creates a self-contained checkpoint and chains the next export to it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cag-checkpoint-"));
  const sessionPath = join(workspace, "session.jsonl");
  await mkdir(join(workspace, "src"));
  await writeFile(
    sessionPath,
    [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Build it" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Half complete" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"),
  );
  const session: SessionInfo = {
    provider: "codex",
    id: "codex-1",
    path: sessionPath,
    cwd: workspace,
    modifiedAt: new Date().toISOString(),
  };
  const runner = new GitRunner();
  const first = await createCheckpoint(runner, session, { mode: "switch", targetProvider: "claude" });
  const second = await createCheckpoint(runner, session, { mode: "fork", targetProvider: "codex", targetSessionId: "codex-1" });

  assert.equal(second.manifest.lineage.parentCheckpointId, first.manifest.id);
  assert.equal(second.manifest.target?.sessionId, "codex-1");
  assert.match(await readFile(first.handoffPath, "utf8"), /Latest user objective\n\nBuild it/);
  assert.match(await readFile(first.transcriptPath, "utf8"), /Half complete/);
  assert.match(await readFile(first.patchPath, "utf8"), /staged patch[\s\S]*working patch/);
  assert.match(await readFile(join(workspace, ".cag", "current", "HANDOFF.md"), "utf8"), /Build it/);
  assert.match(await readFile(join(workspace, ".cag", "current", "TRANSCRIPT.md"), "utf8"), /Half complete/);
  const state = await readGatewayState(workspace);
  assert.equal(state.currentCheckpointId, second.manifest.id);
  assert.equal(state.sessions.codex, "codex-1");
});

test("HANDOFF.md stays free of a Project memory section when memory has nothing to say", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cag-checkpoint-nomemory-"));
  const sessionPath = join(workspace, "session.jsonl");
  await writeFile(
    sessionPath,
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Start" }] } }),
  );
  const session: SessionInfo = {
    provider: "codex",
    id: "codex-empty",
    path: sessionPath,
    cwd: workspace,
    modifiedAt: new Date().toISOString(),
  };
  const checkpoint = await createCheckpoint(new GitRunner(), session, { mode: "export" });
  const handoff = await readFile(checkpoint.handoffPath, "utf8");
  assert.doesNotMatch(handoff, /## Project memory/);
});

test("HANDOFF.md gains an additive Project memory section only when memory is enabled and populated", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cag-checkpoint-memory-"));
  const sessionPath = join(workspace, "session.jsonl");
  await writeFile(
    sessionPath,
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the migration" }] } }),
  );
  const session: SessionInfo = {
    provider: "codex",
    id: "codex-mem",
    path: sessionPath,
    cwd: workspace,
    modifiedAt: new Date().toISOString(),
  };

  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  memory.db
    .prepare(
      "INSERT INTO memory_items (kind, category, text, importance, status, created_at, last_reinforced_at) " +
        "VALUES ('semantic', 'constraint', 'Never truncate the migration log table.', 9, 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
    )
    .run();
  memory.close();

  const enabled = await createCheckpoint(new GitRunner(), session, { mode: "export" });
  const withMemory = await readFile(enabled.handoffPath, "utf8");
  assert.match(withMemory, /## Project memory/);
  assert.match(withMemory, /Never truncate the migration log table\./);
  // Everything before the additive section is untouched Phase 1 content.
  assert.match(withMemory, /## Recent conversation context/);

  const disabled = await createCheckpoint(new GitRunner(), session, {
    mode: "export",
    memoryConfig: { ...DEFAULT_CONFIG.memory, enabled: false },
  });
  const withoutMemory = await readFile(disabled.handoffPath, "utf8");
  assert.doesNotMatch(withoutMemory, /## Project memory/);
});
