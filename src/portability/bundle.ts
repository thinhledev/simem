import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { MemoryDb } from "../memory/db.js";
import { upsertMemoryItem, type MemoryOrigin } from "../memory/items.js";
import type { MemoryCategory, MemoryKind } from "../memory/types.js";
import { ensurePrivateDir, simemHome } from "../store/home.js";
import type { ProjectRef } from "../store/project.js";

// A portable, versioned memory bundle (gzipped JSONL, optionally encrypted):
// curated memory items, summaries, and session metadata — not raw
// transcripts unless asked. Imports merge by content hash, so importing the
// same bundle twice, or bundles that overlap, never duplicates anything.

export const BUNDLE_VERSION = 1;

interface BundleHeader {
  type: "simem-bundle";
  version: number;
  project: { id: string; name: string };
  machine: string;
  exportedAt: string;
}

type Line =
  | ({ kind: "header" } & BundleHeader)
  | { kind: "item"; category: string | null; itemKind: string; text: string; importance: number; status: string; origin: string | null; createdAt: string; reinforcedAt: string }
  | { kind: "summary"; level: number; text: string; coversFrom: string; coversTo: string; checkpointCount: number; milestone: number; createdAt: string }
  | { kind: "session"; id: string; agent: string; externalId: string; surface: string; cwd: string; title: string | null; appSummary: string | null; startedAt: string; lastActivityAt: string }
  | { kind: "message"; checkpointId: string; seq: number; role: string; text: string; timestamp: string | null };

export function machineId(): string {
  const path = join(ensurePrivateDir(simemHome()), "machine-id");
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    const id = randomUUID().slice(0, 8);
    writeFileSync(path, `${id}\n`, { mode: 0o600 });
    return id;
  }
}

export function exportBundle(memory: MemoryDb, project: Pick<ProjectRef, "id" | "name">, options: { transcripts?: boolean } = {}): string {
  const lines: Line[] = [
    { kind: "header", type: "simem-bundle", version: BUNDLE_VERSION, project: { id: project.id, name: project.name }, machine: machineId(), exportedAt: new Date().toISOString() },
  ];
  const items = memory.db
    .prepare("SELECT kind, category, text, importance, status, origin, created_at, last_reinforced_at FROM memory_items WHERE status IN ('active', 'archived') ORDER BY id")
    .all() as Array<{ kind: string; category: string | null; text: string; importance: number; status: string; origin: string | null; created_at: string; last_reinforced_at: string }>;
  for (const item of items) {
    lines.push({ kind: "item", itemKind: item.kind, category: item.category, text: item.text, importance: item.importance, status: item.status, origin: item.origin, createdAt: item.created_at, reinforcedAt: item.last_reinforced_at });
  }
  const summaries = memory.db
    .prepare("SELECT level, text, covers_from, covers_to, checkpoint_count, milestone, created_at FROM summaries WHERE superseded_by IS NULL ORDER BY id")
    .all() as Array<{ level: number; text: string; covers_from: string; covers_to: string; checkpoint_count: number; milestone: number; created_at: string }>;
  for (const summary of summaries) {
    lines.push({ kind: "summary", level: summary.level, text: summary.text, coversFrom: summary.covers_from, coversTo: summary.covers_to, checkpointCount: summary.checkpoint_count, milestone: summary.milestone, createdAt: summary.created_at });
  }
  const sessions = memory.db
    .prepare("SELECT id, agent, external_id, surface, cwd, title, app_summary, started_at, last_activity_at FROM sessions ORDER BY started_at")
    .all() as Array<{ id: string; agent: string; external_id: string; surface: string; cwd: string; title: string | null; app_summary: string | null; started_at: string; last_activity_at: string }>;
  for (const session of sessions) {
    lines.push({ kind: "session", id: session.id, agent: session.agent, externalId: session.external_id, surface: session.surface, cwd: session.cwd, title: session.title, appSummary: session.app_summary, startedAt: session.started_at, lastActivityAt: session.last_activity_at });
  }
  if (options.transcripts) {
    const messages = memory.db.prepare("SELECT m.checkpoint_id, m.seq, m.role, m.text, m.timestamp FROM messages m JOIN sessions s ON s.id = m.checkpoint_id ORDER BY m.checkpoint_id, m.seq").all() as Array<{
      checkpoint_id: string;
      seq: number;
      role: string;
      text: string;
      timestamp: string | null;
    }>;
    for (const message of messages) lines.push({ kind: "message", checkpointId: message.checkpoint_id, seq: message.seq, role: message.role, text: message.text, timestamp: message.timestamp });
  }
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

export interface ImportSummary {
  items: number;
  reinforced: number;
  summaries: number;
  sessions: number;
  messages: number;
}

export function importBundle(memory: MemoryDb, jsonl: string): ImportSummary {
  const summary: ImportSummary = { items: 0, reinforced: 0, summaries: 0, sessions: 0, messages: 0 };
  const lines = jsonl.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Line);
  const header = lines[0];
  if (!header || header.kind !== "header" || header.type !== "simem-bundle") throw new Error("Not a simem memory bundle");
  if (header.version > BUNDLE_VERSION) throw new Error(`Bundle version ${header.version} is newer than this simem supports (${BUNDLE_VERSION}); update simem`);
  memory.db.exec("BEGIN");
  try {
    for (const line of lines.slice(1)) {
      if (line.kind === "item") {
        const result = upsertMemoryItem(
          memory,
          { kind: line.itemKind as MemoryKind, ...(line.category ? { category: line.category as MemoryCategory } : {}), text: line.text, importance: line.importance, origin: (line.origin ?? "import") as MemoryOrigin },
          line.reinforcedAt,
        );
        if (result.reinforced) summary.reinforced += 1;
        else {
          summary.items += 1;
          if (line.status === "archived") memory.db.prepare("UPDATE memory_items SET status = 'archived' WHERE id = ?").run(result.id);
        }
      } else if (line.kind === "summary") {
        const exists = memory.db
          .prepare("SELECT 1 FROM summaries WHERE level = ? AND covers_from = ? AND covers_to = ? AND text = ?")
          .get(line.level, line.coversFrom, line.coversTo, line.text);
        if (!exists) {
          memory.db
            .prepare("INSERT INTO summaries (level, text, covers_from, covers_to, checkpoint_count, created_at, milestone) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(line.level, line.text, line.coversFrom, line.coversTo, line.checkpointCount, line.createdAt, line.milestone);
          summary.summaries += 1;
        }
      } else if (line.kind === "session") {
        memory.db
          .prepare(
            `INSERT OR IGNORE INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json, consolidation_status)
             VALUES (?, ?, ?, ?, ?, 'session', '', '{}', 'done')`,
          )
          .run(line.id, line.startedAt, line.cwd, line.agent, line.externalId);
        const result = memory.db
          .prepare(
            `INSERT OR IGNORE INTO sessions (id, agent, external_id, surface, cwd, title, app_summary, started_at, last_activity_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(line.id, line.agent, line.externalId, line.surface, line.cwd, line.title, line.appSummary, line.startedAt, line.lastActivityAt);
        if (Number(result.changes) > 0) summary.sessions += 1;
      } else if (line.kind === "message") {
        const result = memory.db
          .prepare("INSERT OR IGNORE INTO messages (checkpoint_id, seq, role, text, timestamp) VALUES (?, ?, ?, ?, ?)")
          .run(line.checkpointId, line.seq, line.role, line.text, line.timestamp);
        if (Number(result.changes) > 0) summary.messages += 1;
      }
    }
    memory.db.prepare("UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE checkpoint_id = sessions.id)").run();
    memory.db.exec("COMMIT");
  } catch (error) {
    memory.db.exec("ROLLBACK");
    throw error;
  }
  return summary;
}

// File encoding: gzip, then (with a passphrase) AES-256-GCM with a scrypt-
// derived key. Layout: "SIMEMENC1" | salt(16) | iv(12) | tag(16) | ciphertext.
const ENCRYPTED_MAGIC = Buffer.from("SIMEMENC1");

export function encodeBundle(jsonl: string, passphrase?: string): Buffer {
  const packed = gzipSync(Buffer.from(jsonl));
  if (!passphrase) return packed;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(packed), cipher.final()]);
  return Buffer.concat([ENCRYPTED_MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

export function decodeBundle(data: Buffer, passphrase?: string): string {
  if (data.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC)) {
    if (!passphrase) throw new Error("This bundle is encrypted; set SIMEM_SYNC_PASSPHRASE");
    let offset = ENCRYPTED_MAGIC.length;
    const salt = data.subarray(offset, (offset += 16));
    const iv = data.subarray(offset, (offset += 12));
    const tag = data.subarray(offset, (offset += 16));
    const decipher = createDecipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32), iv);
    decipher.setAuthTag(tag);
    try {
      return gunzipSync(Buffer.concat([decipher.update(data.subarray(offset)), decipher.final()])).toString("utf8");
    } catch {
      throw new Error("Could not decrypt the bundle (wrong SIMEM_SYNC_PASSPHRASE?)");
    }
  }
  if (data[0] === 0x1f && data[1] === 0x8b) return gunzipSync(data).toString("utf8");
  return data.toString("utf8");
}

export interface SyncDirResult {
  wrote: string;
  imported: Array<{ file: string } & ImportSummary>;
}

// Multi-machine sync through any folder the user already syncs (iCloud,
// Dropbox, a network share): each machine writes its own bundle for the
// project and imports everyone else's. Merge-by-hash makes this idempotent.
export function syncThroughDir(memory: MemoryDb, project: Pick<ProjectRef, "id" | "name">, dir: string, passphrase?: string): SyncDirResult {
  ensurePrivateDir(dir);
  const me = machineId();
  const suffix = passphrase ? ".simem.enc" : ".simem.gz";
  const mine = join(dir, `${project.id}.${me}${suffix}`);
  const result: SyncDirResult = { wrote: mine, imported: [] };
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`${project.id}.`) || name.startsWith(`${project.id}.${me}.`)) continue;
    if (!name.endsWith(".simem.enc") && !name.endsWith(".simem.gz")) continue;
    const summary = importBundle(memory, decodeBundle(readFileSync(join(dir, name)), passphrase));
    result.imported.push({ file: name, ...summary });
  }
  const temp = `${mine}.tmp`;
  writeFileSync(temp, encodeBundle(exportBundle(memory, project), passphrase), { mode: 0o600 });
  renameSync(temp, mine);
  return result;
}

