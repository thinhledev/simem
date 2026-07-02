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
import { getTextContent, makeHealth, probeVersion } from "./shared.js";

export class ClaudeAdapter extends BaseAdapter {
  readonly id = "claude" as const;
  readonly capabilities: ProviderCapabilities = {
    structuredEvents: true,
    resumableSessions: true,
    workspaceEdits: true,
    protocol: "cli-jsonl",
  };

  private credential(auth?: Record<string, unknown>): CredentialStatus {
    const apiKey = Boolean(process.env.ANTHROPIC_API_KEY);
    const method = typeof auth?.authMethod === "string" ? auth.authMethod : "";
    const subscription = typeof auth?.subscriptionType === "string" ? auth.subscriptionType : "";
    const source = apiKey ? "ANTHROPIC_API_KEY" : method || "none";
    const detectedTier = apiKey || subscription || /oauth|subscription/i.test(method) ? "paid" : "unknown";
    return {
      tier: this.credentialTier ?? detectedTier,
      source,
      ...(subscription ? { detail: subscription } : {}),
    };
  }

  async health(): Promise<ProviderHealth> {
    const version = await probeVersion(this.runner, this.command);
    if (!version.available) {
      return makeHealth(this.id, this.command, this.capabilities, false, false, this.credential(), version);
    }
    const status = await this.runner.run({
      command: this.command,
      args: ["auth", "status", "--json"],
      timeoutMs: 5_000,
    });
    let auth: Record<string, unknown> | undefined;
    try {
      auth = JSON.parse(status.stdout) as Record<string, unknown>;
    } catch {
      auth = undefined;
    }
    const apiKey = Boolean(process.env.ANTHROPIC_API_KEY);
    const authenticated = apiKey || (status.exitCode === 0 && auth?.loggedIn === true);
    return makeHealth(this.id, this.command, this.capabilities, true, authenticated, this.credential(auth), {
      ...(version.version ? { version: version.version } : {}),
      ...(authenticated ? {} : { detail: "Claude Code is not authenticated" }),
    });
  }

  async run(request: RunRequest, onEvent?: EventHandler): Promise<ProviderRunResult> {
    const events: NormalizedEvent[] = [];
    const emit = (event: Omit<NormalizedEvent, "provider" | "at">): void =>
      this.emit(events, { provider: this.id, at: this.now(), ...event }, onEvent);
    emit({ type: "run.started" });

    const args = [
      "--print",
      request.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      request.accessMode === "read-only" ? "plan" : "acceptEdits",
    ];
    const model = request.model ?? this.model;
    if (model) args.push("--model", model);
    if (request.sessionId) args.push("--resume", request.sessionId);

    let sessionId: string | undefined;
    let finalOutput = "";
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
        } else if (type === "result" && typeof raw.result === "string") {
          finalOutput = raw.result;
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
