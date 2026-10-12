import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic agent homes and transcripts in the real on-disk shapes.

export function claudeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "mixai-claude-home-"));
  mkdirSync(join(dir, "projects"), { recursive: true });
  return dir;
}

export function codexHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "mixai-codex-home-"));
  mkdirSync(join(dir, "sessions", "2026", "10", "12"), { recursive: true });
  return dir;
}

export function claudeSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export interface ClaudeTurn {
  user?: string;
  assistant?: string;
  messageId?: string;
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number };
  toolUse?: { id: string; name: string; input: Record<string, unknown>; result: string; isError?: boolean };
}

export function claudeLines(sessionId: string, cwd: string, turns: ClaudeTurn[], entrypoint = "claude-desktop"): string {
  const lines: unknown[] = [];
  let t = Date.parse("2026-10-12T00:00:00Z");
  const ts = () => new Date((t += 1000)).toISOString();
  for (const turn of turns) {
    if (turn.user) {
      lines.push({ type: "user", sessionId, cwd, entrypoint, timestamp: ts(), message: { role: "user", content: turn.user } });
    }
    const id = turn.messageId ?? `msg_${Math.random().toString(36).slice(2)}`;
    const usage = turn.usage
      ? { input_tokens: turn.usage.input, cache_read_input_tokens: turn.usage.cacheRead, cache_creation_input_tokens: turn.usage.cacheWrite, output_tokens: turn.usage.output }
      : undefined;
    if (turn.toolUse) {
      lines.push({
        type: "assistant", sessionId, cwd, entrypoint, timestamp: ts(),
        message: { id, role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: turn.toolUse.id, name: turn.toolUse.name, input: turn.toolUse.input }], ...(usage ? { usage } : {}) },
      });
      lines.push({
        type: "user", sessionId, cwd, entrypoint, timestamp: ts(),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: turn.toolUse.id, content: turn.toolUse.result, is_error: turn.toolUse.isError ?? false }] },
      });
    }
    if (turn.assistant) {
      // Same message id and usage repeated on a second line, as Claude Code does.
      lines.push({
        type: "assistant", sessionId, cwd, entrypoint, timestamp: ts(),
        message: { id, role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: turn.assistant }], ...(usage ? { usage } : {}) },
      });
    }
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

export function writeClaudeSession(home: string, cwd: string, sessionId: string, turns: ClaudeTurn[], entrypoint?: string): string {
  const dir = join(home, "projects", claudeSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, claudeLines(sessionId, cwd, turns, entrypoint));
  return path;
}

export function appendClaudeTurns(path: string, sessionId: string, cwd: string, turns: ClaudeTurn[]): void {
  appendFileSync(path, claudeLines(sessionId, cwd, turns));
}

export function writeCodexSession(
  home: string,
  cwd: string,
  sessionId: string,
  turns: Array<{ user?: string; assistant?: string; command?: { cmd: string; output: string; exitCode: number }; totalTokens?: number }>,
  originator = "Codex Desktop",
): string {
  const path = join(home, "sessions", "2026", "10", "12", `rollout-2026-10-12T00-00-00-${sessionId}.jsonl`);
  const lines: unknown[] = [
    { timestamp: "2026-10-12T00:00:00Z", type: "session_meta", payload: { id: sessionId, session_id: sessionId, cwd, originator } },
    { timestamp: "2026-10-12T00:00:01Z", type: "turn_context", payload: { cwd, model: "gpt-5.5" } },
  ];
  let n = 0;
  for (const turn of turns) {
    const ts = `2026-10-12T00:01:${String(n++).padStart(2, "0")}Z`;
    if (turn.user) lines.push({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: turn.user }] } });
    if (turn.command) {
      const callId = `call_${n}`;
      lines.push({ timestamp: ts, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: turn.command.cmd }), call_id: callId } });
      lines.push({
        timestamp: ts, type: "response_item",
        payload: { type: "function_call_output", call_id: callId, output: `Process exited with code ${turn.command.exitCode}\nOutput:\n${turn.command.output}` },
      });
    }
    if (turn.assistant) lines.push({ timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: turn.assistant }] } });
    if (turn.totalTokens) {
      const info = {
        total_token_usage: { total_tokens: turn.totalTokens },
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 10 },
      };
      // token_count repeats with unchanged totals.
      lines.push({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info } });
      lines.push({ timestamp: ts, type: "event_msg", payload: { type: "token_count", info } });
    }
  }
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}
