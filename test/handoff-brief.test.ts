import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildBrief } from "../src/handoff/brief.js";
import { createCheckpoint } from "../src/handoff/checkpoints.js";
import type { SessionInfo } from "../src/handoff/types.js";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/process.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

class GitRunner implements CommandRunner {
  async run(spec: CommandSpec): Promise<CommandResult> {
    const args = spec.args ?? [];
    let stdout = "";
    if (args[0] === "branch") stdout = "feature/live\n";
    else if (args[0] === "rev-parse") stdout = "live456\n";
    else if (args[0] === "status") stdout = "## feature/live\n M src/app.ts\n";
    else if (args[0] === "diff") stdout = "patch\n";
    else if (args[0] === "log") stdout = "live456 wip\n";
    return { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false };
  }
}

async function seedCheckpoint(workspace: string): Promise<void> {
  const sessionPath = join(workspace, "session.jsonl");
  await writeFile(
    sessionPath,
    [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Migrate the billing module" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Half done; invoices remain" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"),
  );
  const session: SessionInfo = {
    provider: "codex",
    id: "codex-brief",
    path: sessionPath,
    cwd: workspace,
    modifiedAt: new Date().toISOString(),
  };
  await createCheckpoint(new GitRunner(), session, {
    mode: "export",
    memoryConfig: { ...DEFAULT_CONFIG.memory, enabled: false },
  });
}

test("brief carries checkpoint objective/outcome from manifest.summary plus live git state", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cag-brief-"));
  await seedCheckpoint(workspace);
  const brief = await buildBrief(new GitRunner(), {
    cwd: workspace,
    memoryConfig: { ...DEFAULT_CONFIG.memory, enabled: false },
  });
  assert.match(brief.text, /## Context brief/);
  assert.match(brief.text, /Migrate the billing module/);
  assert.match(brief.text, /Half done; invoices remain/);
  assert.match(brief.text, /Branch: feature\/live/);
  assert.match(brief.text, /HEAD: live456/);
  assert.equal(brief.hasMemory, false);
});

test("brief works with no checkpoint at all — live git state only, objective unknown", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cag-brief-empty-"));
  const brief = await buildBrief(new GitRunner(), {
    cwd: workspace,
    memoryConfig: { ...DEFAULT_CONFIG.memory, enabled: false },
  });
  assert.match(brief.text, /Checkpoint: none yet/);
  assert.match(brief.text, /Unknown — no checkpoint has been created/);
  assert.match(brief.text, /Branch: feature\/live/);
  assert.equal(brief.hasMemory, false);
  assert.equal(brief.truncated, false);
});

test("brief falls back to parsing HANDOFF.md when manifest.summary is absent (pre-Phase-4 checkpoints)", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cag-brief-legacy-"));
  const current = join(workspace, ".cag", "current");
  await mkdir(current, { recursive: true });
  await writeFile(
    join(current, "manifest.json"),
    JSON.stringify({ version: 1, id: "legacy-1", createdAt: "2026-07-01T00:00:00Z", workspace, source: { provider: "codex", sessionId: "s", sessionPath: "p", sessionModifiedAt: "2026-07-01T00:00:00Z" }, lineage: { mode: "export" }, workspaceSnapshot: { dirty: false }, artifacts: { handoff: "HANDOFF.md", transcript: "TRANSCRIPT.md", patch: "WORKSPACE.patch", status: "STATUS.txt" } }),
  );
  await writeFile(
    join(current, "HANDOFF.md"),
    "# Coding-agent handoff\n\n## Latest user objective\n\nLegacy objective text\n\n## Latest agent outcome\n\nLegacy outcome text\n\n## Workspace state\n\n- Branch: x\n",
  );
  const brief = await buildBrief(new GitRunner(), {
    cwd: workspace,
    memoryConfig: { ...DEFAULT_CONFIG.memory, enabled: false },
  });
  assert.match(brief.text, /Legacy objective text/);
  assert.match(brief.text, /Legacy outcome text/);
});

test("brief includes a Project memory section when the database has durable items", withSqlite, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cag-brief-memory-"));
  await seedCheckpoint(workspace);
  const memory = await openMemoryDb(workspace);
  assert.ok(memory);
  memory.db
    .prepare(
      "INSERT INTO memory_items (kind, category, text, importance, status, created_at, last_reinforced_at) " +
        "VALUES ('semantic', 'constraint', 'Billing amounts are integer cents, never floats.', 9, 'active', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')",
    )
    .run();
  memory.close();

  const brief = await buildBrief(new GitRunner(), {
    cwd: workspace,
    memoryConfig: DEFAULT_CONFIG.memory,
  });
  assert.equal(brief.hasMemory, true);
  assert.match(brief.text, /## Project memory/);
  assert.match(brief.text, /integer cents, never floats/);
});

test("brief respects maxChars and reports truncation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cag-brief-cap-"));
  await seedCheckpoint(workspace);
  const brief = await buildBrief(new GitRunner(), {
    cwd: workspace,
    maxChars: 300,
    memoryConfig: { ...DEFAULT_CONFIG.memory, enabled: false },
  });
  assert.ok(brief.text.length <= 301, `brief too long: ${brief.text.length}`);
  assert.equal(brief.truncated, true);
});

test("brief --objective overrides the checkpoint objective", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cag-brief-objective-"));
  await seedCheckpoint(workspace);
  const brief = await buildBrief(new GitRunner(), {
    cwd: workspace,
    objective: "Focus on the invoice tax rules",
    memoryConfig: { ...DEFAULT_CONFIG.memory, enabled: false },
  });
  assert.match(brief.text, /Focus on the invoice tax rules/);
  assert.doesNotMatch(brief.text, /### Latest objective\n\nMigrate the billing module/);
});
