import { classifyFailure, compactError } from "../failures.js";
import { parseJsonLine, type CommandResult } from "../process.js";
import type {
  CredentialStatus,
  EventHandler,
  NormalizedEvent,
  ProviderCapabilities,
  ProviderHealth,
  ProviderRunResult,
  ProviderUsage,
  RunRequest,
} from "../types.js";
import { BaseAdapter } from "./adapter.js";
import { extractUsage, findToolName, getTextContent, makeHealth, probeVersion } from "./shared.js";

export class CursorAdapter extends BaseAdapter {
  readonly id = "cursor" as const;
  readonly capabilities: ProviderCapabilities = {
    structuredEvents: true,
    resumableSessions: true,
    workspaceEdits: true,
    protocol: "cli-jsonl",
  };

  private credential(authenticated = false): CredentialStatus {
    const apiKey = Boolean(process.env.CURSOR_API_KEY);
    return {
      tier: this.credentialTier ?? (apiKey ? "paid" : authenticated ? "included" : "unknown"),
      source: apiKey ? "CURSOR_API_KEY" : authenticated ? "Cursor login" : "none",
    };
  }

  async health(): Promise<ProviderHealth> {
    const version = await probeVersion(this.runner, this.command);
    if (!version.available) {
      return makeHealth(this.id, this.command, this.capabilities, false, false, this.credential(), version);
    }
    const hasApiKey = Boolean(process.env.CURSOR_API_KEY);
    let sessionProbe: CommandResult | undefined;
    if (!hasApiKey) {
      sessionProbe = await this.runner.run({ command: this.command, args: ["ls"], timeoutMs: 5_000 });
    }
    const authenticated = hasApiKey || sessionProbe?.exitCode === 0;
    return makeHealth(this.id, this.command, this.capabilities, true, authenticated, this.credential(authenticated), {
      ...(version.version ? { version: version.version } : {}),
      ...(authenticated
        ? {}
        : { detail: sessionProbe?.stderr.trim() || "Cursor CLI is not authenticated" }),
    });
  }

  async run(request: RunRequest, onEvent?: EventHandler): Promise<ProviderRunResult> {
    const events: NormalizedEvent[] = [];
    const emit = (event: Omit<NormalizedEvent, "provider" | "at">): void =>
      this.emit(events, { provider: this.id, at: this.now(), ...event }, onEvent);
    emit({ type: "run.started" });

    const args = ["--print", "--output-format", "stream-json"];
    if (request.accessMode === "workspace-write") args.push("--force");
    const model = request.model ?? this.model;
    if (model) args.push("--model", model);
    if (request.sessionId) args.push(`--resume=${request.sessionId}`);
    args.push(request.prompt);

    let sessionId: string | undefined;
    let finalOutput = "";
    let usage: ProviderUsage | undefined;
    const deltas: string[] = [];
    const result = await this.runner.run(
      { command: this.command, args, cwd: request.cwd, env: process.env, timeoutMs: request.timeoutMs },
      (line) => {
        const parsed = parseJsonLine(line);
        if (!parsed || typeof parsed !== "object") return;
        const raw = parsed as Record<string, unknown>;
        const type = typeof raw.type === "string" ? raw.type : "";
        if (typeof raw.session_id === "string" && raw.session_id !== sessionId) {
          sessionId = raw.session_id;
          emit({ type: "session.started", sessionId, raw });
        }
        if (type === "assistant") {
          const text = getTextContent(raw.message);
          if (text) {
            deltas.push(text);
            emit({ type: "assistant.delta", text, ...(sessionId ? { sessionId } : {}), raw });
          }
        } else if (type === "tool_call") {
          const toolName = findToolName(raw);
          emit({
            type: raw.subtype === "completed" ? "tool.completed" : "tool.started",
            ...(toolName ? { toolName } : {}),
            ...(sessionId ? { sessionId } : {}),
            raw,
          });
        } else if (type === "result") {
          if (typeof raw.result === "string") finalOutput = raw.result;
          usage = extractUsage(raw) ?? usage;
        }
      },
    );

    const output = finalOutput || deltas.join("");
    if (result.exitCode === 0) {
      emit({ type: "run.completed", text: output, ...(sessionId ? { sessionId } : {}) });
      return {
        provider: this.id,
        ok: true,
        output,
        events,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        ...(sessionId ? { sessionId } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    const failure = classifyFailure(result);
    const error = compactError(result);
    emit({ type: "run.failed", text: error, ...(sessionId ? { sessionId } : {}) });
    return {
      provider: this.id,
      ok: false,
      output,
      events,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      failure,
      error,
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
