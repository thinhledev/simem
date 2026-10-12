import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { symbolsWithRanges } from "../codeindex/indexer.js";
import { detectLanguage } from "../codemap/outline.js";
import type { GatewayConfig } from "../config.js";
import type { RawHookInput } from "../handoff/hooks.js";
import { launcherPath } from "../install/launcher.js";
import { incrementCounter } from "../memory/counters.js";
import { openMemoryDb, type MemoryDb } from "../memory/db.js";
import { sessionKey } from "../sources/ingest.js";
import type { ProviderId } from "../types.js";
import { isNoisyCommand } from "./filters.js";
import { wouldAutoApprove } from "./permissions.js";

// PreToolUse decisions for Claude Code. Every path returns undefined (defer
// to the host's normal flow) unless it is sure; a guard denies a given file at
// most once per session, so the agent can always get what it insists on.

export type PreToolUseDecision = { hookSpecificOutput: Record<string, unknown> };

let rtkCached: boolean | undefined;
function rtkInstalled(): boolean {
  if (rtkCached !== undefined) return rtkCached;
  try {
    execFileSync("/bin/sh", ["-c", "command -v rtk"], { stdio: "ignore", timeout: 1_000 });
    rtkCached = true;
  } catch {
    rtkCached = false;
  }
  return rtkCached;
}

function deny(reason: string): PreToolUseDecision {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function bashRewrite(input: RawHookInput, cwd: string, config: GatewayConfig): PreToolUseDecision | undefined {
  if (config.compression.bashRewrite !== "auto") return undefined;
  const command = typeof input.toolInput?.command === "string" ? input.toolInput.command.trim() : "";
  if (!command || !isNoisyCommand(command)) return undefined;
  if (/^(?:rtk|simem)\b/.test(command) || command.includes("/.simem/bin/simem")) return undefined;
  if (config.compression.rtk === "defer" && rtkInstalled()) return undefined;
  if (!wouldAutoApprove(command, input.permissionMode, cwd)) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      // Allowed only because the original command already was (see wouldAutoApprove).
      permissionDecision: "allow",
      permissionDecisionReason: "simem: same command, output filtered (your settings already allow it)",
      updatedInput: { ...input.toolInput, command: `"${launcherPath()}" exec -- ${shellQuote(command)}` },
    },
  };
}

// One-shot marker per (session, guard, path): the first full read is turned
// into an outline; asking again goes through, and the earlier saving entry is
// withdrawn because it did not happen after all.
function firstTime(memory: MemoryDb, key: string): boolean {
  const existing = memory.db.prepare("SELECT ts FROM hook_runs WHERE key = ?").get(key);
  if (existing) return false;
  memory.db.prepare("INSERT INTO hook_runs (key, ts) VALUES (?, ?)").run(key, new Date().toISOString());
  return true;
}

function recordGuardSaving(memory: MemoryDb, key: string, mechanism: "read-guard" | "reread-guard", full: number, sent: number): void {
  if (full <= sent) return;
  const result = memory.db
    .prepare("INSERT INTO savings_events (mechanism, chars_full, chars_sent, created_at) VALUES (?, ?, ?, ?)")
    .run(mechanism, full, sent, new Date().toISOString());
  memory.db.prepare("UPDATE hook_runs SET ts = ? WHERE key = ?").run(`savings:${Number(result.lastInsertRowid)}`, key);
}

function withdrawGuardSaving(memory: MemoryDb, key: string): void {
  const row = memory.db.prepare("SELECT ts FROM hook_runs WHERE key = ?").get(key) as { ts: string } | undefined;
  const id = row?.ts.startsWith("savings:") ? Number(row.ts.slice(8)) : undefined;
  if (id) memory.db.prepare("DELETE FROM savings_events WHERE id = ?").run(id);
  memory.db.prepare("UPDATE hook_runs SET ts = 'withdrawn' WHERE key = ?").run(key);
}

function readGuards(input: RawHookInput, cwd: string, config: GatewayConfig, memory: MemoryDb): PreToolUseDecision | undefined {
  const filePath = typeof input.toolInput?.file_path === "string" ? input.toolInput.file_path : "";
  if (!filePath || !input.sessionId) return undefined;
  const partial = input.toolInput?.offset !== undefined || input.toolInput?.limit !== undefined;
  const absolute = isAbsolute(filePath) ? filePath : join(cwd, filePath);
  let size: number;
  let mtimeMs: number;
  try {
    const info = statSync(absolute);
    if (!info.isFile()) return undefined;
    size = info.size;
    mtimeMs = Math.round(info.mtimeMs);
  } catch {
    return undefined;
  }
  const session = sessionKey("claude", input.sessionId);
  const display = relative(cwd, absolute).startsWith("..") ? absolute : relative(cwd, absolute);

  if (!partial && config.compression.rereadGuard !== "off") {
    const previous = memory.db.prepare("SELECT size, mtime_ms, full FROM tool_reads WHERE session_id = ? AND path = ?").get(session, absolute) as
      | { size: number; mtime_ms: number; full: number }
      | undefined;
    if (previous?.full && previous.size === size && previous.mtime_ms === mtimeMs) {
      const key = `reread:${session}:${absolute}`;
      if (config.compression.rereadGuard === "enforce" || firstTime(memory, key)) {
        const reason = `simem: ${display} has not changed since you read it in full earlier in this session, so its content is already in your context. Re-read only if you lost it (call Read again to get it anyway).`;
        recordGuardSaving(memory, key, "reread-guard", size, reason.length);
        incrementCounter(memory, "guard:reread-guard");
        return deny(reason);
      }
      withdrawGuardSaving(memory, key);
    }
  }

  if (!partial && config.compression.readGuard !== "off") {
    let source: string | undefined;
    try {
      source = size < 5_000_000 ? readFileSync(absolute, "utf8") : undefined;
    } catch {
      source = undefined;
    }
    const lines = source ? source.split("\n").length : 0;
    if (source && lines > config.compression.largeReadLines) {
      const key = `readwarn:${session}:${absolute}`;
      if (config.compression.readGuard === "enforce" || firstTime(memory, key)) {
        const symbols = symbolsWithRanges(source, detectLanguage(absolute)).slice(0, 80);
        const outline = symbols.length
          ? symbols.map((symbol) => `  ${symbol.start}-${symbol.end}  ${symbol.kind} ${symbol.name}`).join("\n")
          : "  (no symbols recognised)";
        const reason =
          `simem: ${display} has ${lines} lines (~${Math.round(size / 3.6 / 1000)}k tokens). Outline:\n${outline}\n` +
          "Read just the part you need with offset/limit (or the code_read tool)." +
          (config.compression.readGuard === "enforce" ? "" : " Call Read again without offset/limit if you really need the whole file.");
        recordGuardSaving(memory, key, "read-guard", size, reason.length);
        incrementCounter(memory, "guard:read-guard");
        return deny(reason);
      }
      withdrawGuardSaving(memory, key);
    }
  }

  memory.db
    .prepare(
      `INSERT INTO tool_reads (session_id, path, size, mtime_ms, full, ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
         full = MAX(CASE WHEN excluded.size = tool_reads.size AND excluded.mtime_ms = tool_reads.mtime_ms THEN tool_reads.full ELSE 0 END, excluded.full),
         ts = excluded.ts`,
    )
    .run(session, absolute, size, mtimeMs, partial ? 0 : 1, new Date().toISOString());
  return undefined;
}

export async function decidePreToolUse(
  input: RawHookInput,
  cwd: string,
  provider: ProviderId,
  config: GatewayConfig,
): Promise<PreToolUseDecision | undefined> {
  if (provider !== "claude") return undefined;
  if (input.toolName === "Bash") return bashRewrite(input, cwd, config);
  if (input.toolName !== "Read") return undefined;
  const memory = await openMemoryDb(cwd, { quiet: true });
  if (!memory) return undefined;
  try {
    return readGuards(input, cwd, config, memory);
  } finally {
    memory.close();
  }
}
