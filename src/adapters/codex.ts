import { classifyFailure, compactError } from "../failures.js";
import { parseJsonLine } from "../process.js";
import type {
  CredentialStatus,
  EventHandler,
  NormalizedEvent,
  ProviderCapabilities,
  ProviderHealth,
  ProviderRunResult,
  RunRequest,
} from "../types.js";
import { BaseAdapter } from "./adapter.js";
import { makeHealth, probeVersion } from "./shared.js";

export class CodexAdapter extends BaseAdapter {
  readonly id = "codex" as const;
  readonly capabilities: ProviderCapabilities = {
    structuredEvents: true,
    resumableSessions: true,
    workspaceEdits: true,
    protocol: "cli-jsonl",
  };

  private credential(statusText = ""): CredentialStatus {
    const hasApiKey = Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY);
    const source = hasApiKey
      ? process.env.CODEX_API_KEY
        ? "CODEX_API_KEY"
        : "OPENAI_API_KEY via CODEX_API_KEY"
      : /api key/i.test(statusText)
        ? "saved API key"
        : /chatgpt/i.test(statusText)
          ? "ChatGPT login"
          : "none";
    const detectedTier = hasApiKey || /api key/i.test(statusText) ? "paid" : /chatgpt/i.test(statusText) ? "included" : "unknown";
    return { tier: this.credentialTier ?? detectedTier, source };
  }

  async health(): Promise<ProviderHealth> {
    const version = await probeVersion(this.runner, this.command);
    if (!version.available) {
      return makeHealth(this.id, this.command, this.capabilities, false, false, this.credential(), version);
    }
    const auth = await this.runner.run({
      command: this.command,
      args: ["login", "status"],
      timeoutMs: 5_000,
    });
    const statusText = `${auth.stdout}\n${auth.stderr}`.trim();
    const hasApiKey = Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY);
    return makeHealth(
      this.id,
      this.command,
      this.capabilities,
      true,
      hasApiKey || auth.exitCode === 0,
      this.credential(statusText),
      {
        ...(version.version ? { version: version.version } : {}),
        ...(auth.exitCode === 0 || hasApiKey ? {} : { detail: statusText || "Codex is not authenticated" }),
      },
    );
  }

  async run(request: RunRequest, onEvent?: EventHandler): Promise<ProviderRunResult> {
    const events: NormalizedEvent[] = [];
    const emit = (event: Omit<NormalizedEvent, "provider" | "at">): void =>
      this.emit(events, { provider: this.id, at: this.now(), ...event }, onEvent);
    emit({ type: "run.started" });

    const args = [
      "exec",
      "--json",
      "--color",
      "never",
      "--cd",
      request.cwd,
      "--sandbox",
      request.accessMode,
    ];
    const model = request.model ?? this.model;
    if (model) args.push("--model", model);
    if (request.sessionId) args.push("resume", request.sessionId, request.prompt);
    else args.push(request.prompt);

    let sessionId: string | undefined;
    const messages: string[] = [];
    const env = { ...process.env };
    if (!env.CODEX_API_KEY && env.OPENAI_API_KEY) env.CODEX_API_KEY = env.OPENAI_API_KEY;

    const result = await this.runner.run(
      { command: this.command, args, cwd: request.cwd, env, timeoutMs: request.timeoutMs },
      (line) => {
        const parsed = parseJsonLine(line);
        if (!parsed || typeof parsed !== "object") return;
        const raw = parsed as Record<string, unknown>;
        const type = typeof raw.type === "string" ? raw.type : "";
        if (type === "thread.started" && typeof raw.thread_id === "string") {
          sessionId = raw.thread_id;
          emit({ type: "session.started", sessionId, raw });
          return;
        }
        const item = raw.item && typeof raw.item === "object" ? (raw.item as Record<string, unknown>) : undefined;
        if (type === "item.started" && item && item.type !== "reasoning") {
          emit({
            type: "tool.started",
            ...(typeof item.type === "string" ? { toolName: item.type } : {}),
            ...(sessionId ? { sessionId } : {}),
            raw,
          });
          return;
        }
        if (type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
          messages.push(item.text);
          emit({ type: "assistant.delta", text: item.text, ...(sessionId ? { sessionId } : {}), raw });
          return;
        }
        if (type === "item.completed" && item && item.type !== "reasoning") {
          emit({
            type: "tool.completed",
            ...(typeof item.type === "string" ? { toolName: item.type } : {}),
            ...(sessionId ? { sessionId } : {}),
            raw,
          });
        }
      },
    );

    const output = messages.at(-1) ?? "";
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
    };
  }
}
