import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CheckpointManifest } from "../src/handoff/types.js";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import { indexCheckpoint } from "../src/memory/index-checkpoint.js";
import { parseTranscriptMarkdown, reindexMemory } from "../src/memory/reindex.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

function manifest(id: string, overrides: Partial<CheckpointManifest> = {}): CheckpointManifest {
  return {
    version: 1,
    id,
    createdAt: "2026-07-03T00:00:00.000Z",
    workspace: "/tmp/workspace",
    source: {
      provider: "codex",
      sessionId: `session-${id}`,
      sessionPath: `/nonexistent/${id}.jsonl`,
      sessionModifiedAt: "2026-07-03T00:00:00.000Z",
    },
    lineage: { mode: "export" },
    workspaceSnapshot: { dirty: false },
    artifacts: {
      handoff: "HANDOFF.md",
      transcript: "TRANSCRIPT.md",
      patch: "WORKSPACE.patch",
      status: "STATUS.txt",
    },
    ...overrides,
  };
}

test("indexing a checkpoint twice is an upsert, not a duplicate", withSqlite, async () => {
  const memory = await openMemoryDb(process.cwd(), { path: ":memory:" });
  assert.ok(memory);
  try {
    const messages = [
      { role: "user" as const, text: "add retry logic to the uploader" },
      { role: "assistant" as const, text: "Implemented exponential backoff." },
    ];
    indexCheckpoint(memory, manifest("cp-1"), messages, "checkpoints/cp-1");
    indexCheckpoint(memory, manifest("cp-1", { workspaceSnapshot: { dirty: true } }), messages, "checkpoints/cp-1");

    const checkpoints = memory.db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as { n: number };
    assert.equal(checkpoints.n, 1);
    const dirty = memory.db.prepare("SELECT dirty FROM checkpoints WHERE id = 'cp-1'").get() as { dirty: number };
    assert.equal(dirty.dirty, 1);
    const rows = memory.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE checkpoint_id = 'cp-1'").get() as { n: number };
    assert.equal(rows.n, 2);
  } finally {
    memory.close();
  }
});

test("parses the exported TRANSCRIPT.md format back into messages", () => {
  const content = `# Extracted codex conversation

Session: abc
Workspace: /tmp/w

## User · 2026-07-01T10:00:00Z

Fix the flaky test

---

## Assistant

Stabilized the polling helper.

Second paragraph survives.`;
  const messages = parseTranscriptMarkdown(content);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], {
    role: "user",
    text: "Fix the flaky test",
    timestamp: "2026-07-01T10:00:00Z",
  });
  assert.equal(messages[1]?.role, "assistant");
  assert.match(messages[1]?.text ?? "", /Second paragraph survives\./);
});

test("reindex backfills a checkpoint tree and --rebuild stays idempotent", withSqlite, async () => {
  const root = await mkdtemp(join(tmpdir(), "simem-memory-reindex-"));
  const first = join(root, ".simem", "checkpoints", "2026-07-01T00-00-00-000Z-aaaa1111");
  const second = join(root, ".simem", "checkpoints", "2026-07-02T00-00-00-000Z-bbbb2222");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeFile(
    join(first, "manifest.json"),
    JSON.stringify(manifest("2026-07-01T00-00-00-000Z-aaaa1111")),
  );
  await writeFile(
    join(first, "TRANSCRIPT.md"),
    "# Extracted codex conversation\n\nSession: s\nWorkspace: /tmp/w\n\n## User\n\nShip the login page\n\n---\n\n## Assistant\n\nDone; added form validation.",
  );
  await writeFile(
    join(second, "manifest.json"),
    JSON.stringify(manifest("2026-07-02T00-00-00-000Z-bbbb2222")),
  );
  await writeFile(join(second, "TRANSCRIPT.md"), "# Extracted codex conversation\n\n## User\n\nNow add SSO");
  // A malformed directory must be skipped without failing the whole reindex.
  const broken = join(root, ".simem", "checkpoints", "broken");
  await mkdir(broken, { recursive: true });
  await writeFile(join(broken, "manifest.json"), "not json");

  const memory = await openMemoryDb(root);
  assert.ok(memory);
  try {
    const resultA = await reindexMemory(memory, root);
    assert.equal(resultA.checkpoints, 2);
    assert.equal(resultA.messages, 3);
    assert.equal(resultA.skipped.length, 1);

    const resultB = await reindexMemory(memory, root, { rebuild: true });
    assert.equal(resultB.checkpoints, 2);
    const counts = memory.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
    assert.equal(counts.n, 3);
  } finally {
    memory.close();
  }
});
