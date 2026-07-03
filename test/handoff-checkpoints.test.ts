import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCheckpoint, readGatewayState } from "../src/handoff/checkpoints.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/process.js";
import type { SessionInfo } from "../src/handoff/types.js";

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
