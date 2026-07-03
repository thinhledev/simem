import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { CommandRunner } from "../process.js";
import { PROVIDER_APP_NAME, type ProviderId } from "../types.js";
import { createCheckpoint, readGatewayState } from "./checkpoints.js";
import { ensureClaudeHandoffMemory, type ClaudeMemoryIntegration } from "./claude-memory.js";
import { discoverSessions, resolveSession } from "./sessions.js";
import type { CreatedCheckpoint, SessionInfo } from "./types.js";

export type SwitchSurface = "interactive" | "desktop";

export interface SwitchOptions {
  cwd: string;
  target: ProviderId;
  source?: ProviderId;
  sourceSession?: string;
  targetSession?: string;
  newSession?: boolean;
  fork?: boolean;
  note?: string;
  surface?: SwitchSurface;
}

export interface SwitchPlan {
  checkpoint: CreatedCheckpoint;
  sourceSession: SessionInfo;
  targetSession?: SessionInfo;
  command: string;
  args: string[];
  prompt: string;
  surface: SwitchSurface;
  claudeMemory?: ClaudeMemoryIntegration;
}

export async function resolveSourceSession(
  cwd: string,
  source?: ProviderId,
  selector = "latest",
): Promise<SessionInfo> {
  if (source) return await resolveSession(source, cwd, selector);
  const sessions = (
    await Promise.all([discoverSessions("codex", cwd), discoverSessions("claude", cwd)])
  )
    .flat()
    .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
  const session = sessions[0];
  if (!session) throw new Error(`No Codex or Claude session was found for ${resolve(cwd)}`);
  return session;
}

async function chooseTargetSession(options: SwitchOptions): Promise<SessionInfo | undefined> {
  if (options.newSession) return undefined;
  if (options.targetSession) return await resolveSession(options.target, options.cwd, options.targetSession);
  const state = await readGatewayState(options.cwd);
  const bound = state.sessions[options.target];
  if (bound) {
    try {
      return await resolveSession(options.target, options.cwd, bound);
    } catch {
      // Fall through to the latest provider session if a local session was removed.
    }
  }
  return (await discoverSessions(options.target, options.cwd))[0];
}

function continuationPrompt(checkpoint: CreatedCheckpoint): string {
  return `Continue from cross-agent checkpoint ${checkpoint.manifest.id}. Read ${checkpoint.handoffPath} first. Use TRANSCRIPT.md and WORKSPACE.patch in the same directory when more detail is needed. Inspect the live Git state before editing, then continue the latest unfinished user objective without repeating completed work.`;
}

function targetCommand(
  target: ProviderId,
  cwd: string,
  prompt: string,
  session: SessionInfo | undefined,
  fork: boolean,
  surface: SwitchSurface,
  newSession: boolean,
): { command: string; args: string[] } {
  if (target === "codex") {
    if (surface === "desktop") return { command: "codex", args: ["app", cwd] };
    if (fork && session) return { command: "codex", args: ["-C", cwd, "fork", session.id, prompt] };
    if (session) return { command: "codex", args: ["-C", cwd, "resume", session.id, prompt] };
    return { command: "codex", args: ["-C", cwd, prompt] };
  }
  if (target === "claude") {
    if (surface === "desktop") {
      if (process.platform === "darwin") return { command: "open", args: ["-a", "Claude"] };
      throw new Error("Claude Desktop launch is currently supported on macOS; use --surface interactive");
    }
    const args: string[] = [];
    if (session) args.push("--resume", session.id);
    if (fork && session) args.push("--fork-session");
    args.push(prompt);
    return { command: "claude", args };
  }
  if (target === "cursor") {
    if (surface === "desktop") {
      if (process.platform === "darwin") return { command: "open", args: ["-a", PROVIDER_APP_NAME.cursor, cwd] };
      throw new Error("Cursor Desktop launch is currently supported on macOS; use --surface interactive");
    }
    const args = session ? [`--resume=${session.id}`, prompt] : [prompt];
    return { command: "cursor-agent", args };
  }
  if (surface === "desktop") {
    if (process.platform === "darwin") return { command: "open", args: ["-a", PROVIDER_APP_NAME.antigravity] };
    throw new Error("Antigravity Desktop launch is currently supported on macOS; use --surface interactive");
  }
  // `agy` is Antigravity's real terminal agent CLI (distinct from the
  // `antigravity`/`agy` symlinks the desktop app installs under
  // ~/.antigravity, which can be dangling on a fresh or updated install).
  // It has no flag to point the *desktop app* at a folder, so this only
  // covers --surface interactive, not opening a specific project in the GUI.
  const args = newSession ? ["--new-project"] : ["--continue"];
  args.push("-i", prompt);
  return { command: "agy", args };
}

export async function prepareSwitch(runner: CommandRunner, options: SwitchOptions): Promise<SwitchPlan> {
  const cwd = resolve(options.cwd);
  const surface = options.surface ?? (process.platform === "darwin" ? "desktop" : "interactive");
  const sourceSession = await resolveSourceSession(cwd, options.source, options.sourceSession ?? "latest");
  const targetSession = await chooseTargetSession({ ...options, cwd });
  const checkpoint = await createCheckpoint(runner, sourceSession, {
    mode: options.fork ? "fork" : "switch",
    targetProvider: options.target,
    ...(targetSession ? { targetSessionId: targetSession.id } : {}),
    ...(options.note ? { note: options.note } : {}),
  });
  const claudeMemory = options.target === "claude" && surface === "desktop"
    ? await ensureClaudeHandoffMemory(cwd)
    : undefined;
  const prompt = continuationPrompt(checkpoint);
  const launch = targetCommand(
    options.target,
    cwd,
    prompt,
    targetSession,
    Boolean(options.fork),
    surface,
    Boolean(options.newSession),
  );
  return {
    checkpoint,
    sourceSession,
    ...(targetSession ? { targetSession } : {}),
    prompt,
    surface,
    ...(claudeMemory ? { claudeMemory } : {}),
    ...launch,
  };
}

export async function launchSwitch(plan: SwitchPlan): Promise<number | null> {
  return await new Promise((resolveLaunch, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.checkpoint.manifest.workspace,
      env: process.env,
      stdio: plan.surface === "desktop" ? "ignore" : "inherit",
      detached: plan.surface === "desktop",
      shell: false,
    });
    child.on("error", reject);
    if (plan.surface === "desktop") {
      child.on("spawn", () => {
        child.unref();
        resolveLaunch(0);
      });
    } else {
      child.on("close", resolveLaunch);
    }
  });
}

export function displayCommand(plan: SwitchPlan): string {
  return [plan.command, ...plan.args]
    .map((part) => `'${part.replace(/'/g, `'"'"'`)}'`)
    .join(" ");
}
