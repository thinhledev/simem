import type { CheckpointManifest, TranscriptMessage } from "../handoff/types.js";
import type { MemoryDb } from "./db.js";
import { openMemoryDb } from "./db.js";

// Pure parsing — no LLM call. Safe to run inside the token-free checkpoint
// path. Re-ingesting the same checkpoint id is an upsert, not a duplicate.
export function indexCheckpoint(
  memory: MemoryDb,
  manifest: CheckpointManifest,
  messages: TranscriptMessage[],
  directory: string,
): void {
  memory.db
    .prepare(
      `INSERT INTO checkpoints (
        id, created_at, workspace, source_provider, source_session_id, lineage_mode,
        parent_checkpoint_id, target_provider, target_session_id,
        branch, head, dirty, directory, manifest_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        created_at = excluded.created_at,
        workspace = excluded.workspace,
        source_provider = excluded.source_provider,
        source_session_id = excluded.source_session_id,
        lineage_mode = excluded.lineage_mode,
        parent_checkpoint_id = excluded.parent_checkpoint_id,
        target_provider = excluded.target_provider,
        target_session_id = excluded.target_session_id,
        branch = excluded.branch,
        head = excluded.head,
        dirty = excluded.dirty,
        directory = excluded.directory,
        manifest_json = excluded.manifest_json`,
    )
    .run(
      manifest.id,
      manifest.createdAt,
      manifest.workspace,
      manifest.source.provider,
      manifest.source.sessionId,
      manifest.lineage.mode,
      manifest.lineage.parentCheckpointId ?? null,
      manifest.target?.provider ?? null,
      manifest.target?.sessionId ?? null,
      manifest.workspaceSnapshot.branch ?? null,
      manifest.workspaceSnapshot.head ?? null,
      manifest.workspaceSnapshot.dirty ? 1 : 0,
      directory,
      JSON.stringify(manifest),
    );

  memory.db.prepare("DELETE FROM messages WHERE checkpoint_id = ?").run(manifest.id);
  const insert = memory.db.prepare(
    "INSERT INTO messages (checkpoint_id, seq, role, text, timestamp) VALUES (?, ?, ?, ?, ?)",
  );
  messages.forEach((message, seq) => {
    insert.run(manifest.id, seq, message.role, message.text, message.timestamp ?? null);
  });
}

// Best-effort wrapper for the checkpoint path: silent on unsupported runtimes,
// never throws — a memory failure must not break switch/export.
export async function indexCheckpointBestEffort(
  cwd: string,
  manifest: CheckpointManifest,
  messages: TranscriptMessage[],
  directory: string,
): Promise<boolean> {
  try {
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return false;
    try {
      indexCheckpoint(memory, manifest, messages, directory);
      return true;
    } finally {
      memory.close();
    }
  } catch {
    return false;
  }
}
