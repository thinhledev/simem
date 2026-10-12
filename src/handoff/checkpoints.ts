import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DEFAULT_CONFIG, type MemoryConfig } from "../config.js";
import { assembleContext } from "../memory/budget.js";
import { openMemoryDb } from "../memory/db.js";
import { indexCheckpointBestEffort } from "../memory/index-checkpoint.js";
import { isInternalMemoryPrompt } from "../memory/internal-prompt.js";
import { capText } from "../memory/text-cap.js";
import type { CommandRunner } from "../process.js";
import type { ProviderId } from "../types.js";
import { extractTranscript } from "./sessions.js";
import type {
  CheckpointManifest,
  CreatedCheckpoint,
  GatewayState,
  SessionInfo,
  TranscriptMessage,
} from "./types.js";
import { captureWorkspace } from "./workspace.js";

const EMPTY_STATE: GatewayState = { version: 1, checkpoints: {}, sessions: {} };

// Bounds manifest.summary so one tool-output-heavy final message can't bloat
// every manifest.json; `mixai brief` re-caps to its own budget on read anyway.
const MANIFEST_SUMMARY_CAP = 2_000;

function gatewayDirectory(cwd: string): string {
  return join(resolve(cwd), ".mixai");
}

export async function readGatewayState(cwd: string): Promise<GatewayState> {
  const path = join(gatewayDirectory(cwd), "state.json");
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as GatewayState;
    return state.version === 1 ? state : { ...EMPTY_STATE };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STATE, checkpoints: {}, sessions: {} };
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeGatewayState(cwd: string, state: GatewayState): Promise<string> {
  const directory = gatewayDirectory(cwd);
  const path = join(directory, "state.json");
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return path;
}

function formatTranscript(messages: TranscriptMessage[], session: SessionInfo): string {
  const sections = messages.map((message) => {
    const label = message.role === "user" ? "User" : "Assistant";
    const timestamp = message.timestamp ? ` · ${message.timestamp}` : "";
    return `## ${label}${timestamp}\n\n${message.text}`;
  });
  return `# Extracted ${session.provider} conversation\n\nSession: ${session.id}\nWorkspace: ${session.cwd}\n\n${sections.join("\n\n---\n\n")}\n`;
}

// `verbatimBudget` is only passed when memory is enabled: it caps this
// section the same way the memory system caps everything else it touches,
// so a handful of huge tool-output-heavy messages can't blow up every future
// HANDOFF.md's first read. When memory is disabled, this stays fully
// unbounded — the original Phase 1 behavior, byte-identical.
function recentContext(messages: TranscriptMessage[], verbatimBudget: number | undefined, count = 8): string {
  const recent = messages.slice(-count);
  const blocks = (message: TranscriptMessage, text: string) =>
    `### ${message.role === "user" ? "User" : "Assistant"}\n\n${text}`;
  if (verbatimBudget === undefined) {
    return recent.map((message) => blocks(message, message.text)).join("\n\n");
  }
  const perMessageCap = Math.max(200, Math.floor(verbatimBudget / Math.max(1, recent.length)));
  const joined = recent.map((message) => blocks(message, capText(message.text, perMessageCap).text)).join("\n\n");
  return capText(joined, verbatimBudget).text;
}

function latestText(messages: TranscriptMessage[], role: TranscriptMessage["role"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role) return message.text;
  }
  return "Not available in the local transcript.";
}

// Cap for the objective line in BRIEF.md. This file is @-imported into
// CLAUDE.local.md, which the host agent re-sends to the model on EVERY turn
// (an @import is persistent system-prompt context, not a one-time session-start
// injection). So BRIEF.md must stay tiny — the full objective/transcript/memory
// live in HANDOFF.md and `mixai brief`.
const BRIEF_OBJECTIVE_CAP = 600;


// The lean, per-turn continuity payload. Unlike HANDOFF.md (full transcript +
// memory), this is only objective + live pointer, because relevant project
// memory is already injected per-prompt by the UserPromptSubmit hook and the
// full handoff is one Read away.
function formatBrief(input: { id: string; branch?: string; head?: string; objective: string }): string {
  const objective = isInternalMemoryPrompt(input.objective)
    ? "See HANDOFF.md — the last checkpoint captured an internal memory step, not a user objective."
    : capText(input.objective, BRIEF_OBJECTIVE_CAP).text || "Not captured.";
  return `# Mixai continuity brief

Latest objective (checkpoint ${input.id}): ${objective}

Workspace: ${input.branch ?? "unborn or detached"} @ ${input.head ?? "no commit"}

This compact brief is injected on every turn — it is intentionally minimal. When the user asks to continue, inspect the live repository and git state first, then resume the latest unfinished objective without redoing completed work. For the full prior-agent handoff (recent transcript, workspace patch, durable decisions) read \`.mixai/current/HANDOFF.md\`, or run \`mixai brief\` / the \`context_brief\` MCP tool for a fresh objective + live git + relevant memory. Project memory relevant to each prompt is injected automatically.
`;
}

// Derives a minimal BRIEF.md from an existing HANDOFF.md (migration path for
// workspaces whose latest checkpoint predates BRIEF.md, so the @import never
// points at a missing file). Best-effort: returns undefined if it can't parse.
export function briefFromHandoff(handoff: string): string | undefined {
  const objective = /^## Latest user objective\n\n([\s\S]*?)(?=\n## |$)/m.exec(handoff)?.[1]?.trim();
  const id = /^Checkpoint:\s*(.+)$/m.exec(handoff)?.[1]?.trim() ?? "unknown";
  const branch = /- Branch:\s*(.+)$/m.exec(handoff)?.[1]?.trim();
  const head = /- HEAD:\s*(.+)$/m.exec(handoff)?.[1]?.trim();
  if (!objective) return undefined;
  return formatBrief({
    id,
    objective,
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
  });
}

function formatHandoff(input: {
  id: string;
  createdAt: string;
  session: SessionInfo;
  messages: TranscriptMessage[];
  branch?: string;
  head?: string;
  status: string;
  recentCommits: string;
  note?: string;
  parentCheckpointId?: string;
  memorySection?: string;
  verbatimBudget?: number;
}): string {
  return `# Coding-agent handoff

Checkpoint: ${input.id}
Created: ${input.createdAt}
Source: ${input.session.provider} session ${input.session.id}
Workspace: ${input.session.cwd}
Parent checkpoint: ${input.parentCheckpointId ?? "none"}

## Continuation contract

Continue the unfinished work in this existing workspace. Inspect the current files and Git state before editing; the workspace is live and may be newer than this export. Treat this file as the concise handoff and consult \`TRANSCRIPT.md\` for the full extracted conversation or \`WORKSPACE.patch\` for tracked changes. Do not repeat completed work.

## Latest user objective

${latestText(input.messages, "user")}

## Latest agent outcome

${latestText(input.messages, "assistant")}
${input.note ? `\n## Operator note\n\n${input.note}\n` : ""}
## Workspace state

- Branch: ${input.branch ?? "unborn or detached"}
- HEAD: ${input.head ?? "no commit"}

\`\`\`text
${input.status || "Clean or unavailable"}
\`\`\`

## Recent commits

\`\`\`text
${input.recentCommits || "No commits available"}
\`\`\`

## Recent conversation context

${recentContext(input.messages, input.verbatimBudget)}
${input.memorySection ? `\n${input.memorySection}` : ""}`;
}

// Best-effort: reads previously consolidated memory (durable decisions, top
// retrieval hits, latest digest) into a budgeted markdown block. Returns ""
// when memory is disabled, unavailable, or empty, so HANDOFF.md stays byte-
// identical to the Phase 1 format in those cases.
async function buildMemorySection(
  cwd: string,
  latestObjective: string,
  memoryConfig: MemoryConfig,
): Promise<string> {
  if (!memoryConfig.enabled) return "";
  try {
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (!memory) return "";
    try {
      return (await assembleContext(memory, latestObjective, memoryConfig.budget, memoryConfig.scoring)).text;
    } finally {
      memory.close();
    }
  } catch {
    return "";
  }
}

export interface CreateCheckpointOptions {
  mode: "export" | "switch" | "fork";
  targetProvider?: ProviderId;
  targetSessionId?: string;
  note?: string;
  memoryConfig?: MemoryConfig;
}

export async function createCheckpoint(
  runner: CommandRunner,
  session: SessionInfo,
  options: CreateCheckpointOptions,
): Promise<CreatedCheckpoint> {
  const cwd = resolve(session.cwd);
  const state = await readGatewayState(cwd);
  const messages = await extractTranscript(session);
  const workspace = await captureWorkspace(runner, cwd);
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const directory = join(gatewayDirectory(cwd), "checkpoints", id);
  await mkdir(directory, { recursive: true });

  const handoffName = "HANDOFF.md";
  const transcriptName = "TRANSCRIPT.md";
  const patchName = "WORKSPACE.patch";
  const statusName = "STATUS.txt";
  const handoffPath = join(directory, handoffName);
  const transcriptPath = join(directory, transcriptName);
  const patchPath = join(directory, patchName);
  const statusPath = join(directory, statusName);
  const currentDirectory = join(gatewayDirectory(cwd), "current");
  await mkdir(currentDirectory, { recursive: true });
  const parentCheckpointId = state.currentCheckpointId;
  const manifest: CheckpointManifest = {
    version: 1,
    id,
    createdAt,
    workspace: cwd,
    source: {
      provider: session.provider,
      sessionId: session.id,
      sessionPath: session.path,
      sessionModifiedAt: session.modifiedAt,
    },
    lineage: {
      mode: options.mode,
      ...(parentCheckpointId ? { parentCheckpointId } : {}),
    },
    ...(options.targetProvider
      ? {
          target: {
            provider: options.targetProvider,
            ...(options.targetSessionId ? { sessionId: options.targetSessionId } : {}),
          },
        }
      : {}),
    workspaceSnapshot: {
      ...(workspace.branch ? { branch: workspace.branch } : {}),
      ...(workspace.head ? { head: workspace.head } : {}),
      dirty: Boolean(workspace.status.split(/\r?\n/).some((line) => line && !line.startsWith("##"))),
    },
    artifacts: {
      handoff: handoffName,
      transcript: transcriptName,
      patch: patchName,
      status: statusName,
    },
    summary: {
      latestObjective: capText(latestText(messages, "user"), MANIFEST_SUMMARY_CAP).text,
      latestOutcome: capText(latestText(messages, "assistant"), MANIFEST_SUMMARY_CAP).text,
    },
  };

  const memoryConfig = options.memoryConfig ?? DEFAULT_CONFIG.memory;
  const memorySection = await buildMemorySection(cwd, latestText(messages, "user"), memoryConfig);
  const handoff = formatHandoff({
    id,
    createdAt,
    session,
    messages,
    status: workspace.status,
    recentCommits: workspace.recentCommits,
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    ...(workspace.head ? { head: workspace.head } : {}),
    ...(options.note ? { note: options.note } : {}),
    ...(parentCheckpointId ? { parentCheckpointId } : {}),
    ...(memorySection ? { memorySection } : {}),
    ...(memoryConfig.enabled ? { verbatimBudget: memoryConfig.budget.verbatimChars } : {}),
  });
  const transcript = formatTranscript(messages, session);
  const patch = `${workspace.diff}\n`;
  const status = `${workspace.status}\n`;
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  // Lean per-turn import (see formatBrief): keeps CLAUDE.local.md's @import
  // small so the full HANDOFF.md isn't re-sent to the model every message.
  const briefName = "BRIEF.md";
  const brief = formatBrief({
    id,
    objective: latestText(messages, "user"),
    ...(workspace.branch ? { branch: workspace.branch } : {}),
    ...(workspace.head ? { head: workspace.head } : {}),
  });
  await Promise.all([
    writeFile(handoffPath, handoff, "utf8"),
    writeFile(transcriptPath, transcript, "utf8"),
    writeFile(patchPath, patch, "utf8"),
    writeFile(statusPath, status, "utf8"),
    writeFile(join(directory, briefName), brief, "utf8"),
    writeFile(join(directory, "manifest.json"), manifestJson, "utf8"),
    writeFile(join(gatewayDirectory(cwd), "CURRENT.md"), handoff, "utf8"),
    writeFile(join(currentDirectory, handoffName), handoff, "utf8"),
    writeFile(join(currentDirectory, briefName), brief, "utf8"),
    writeFile(join(currentDirectory, transcriptName), transcript, "utf8"),
    writeFile(join(currentDirectory, patchName), patch, "utf8"),
    writeFile(join(currentDirectory, statusName), status, "utf8"),
    writeFile(join(currentDirectory, "manifest.json"), manifestJson, "utf8"),
  ]);

  state.currentCheckpointId = id;
  state.checkpoints[id] = relative(cwd, directory);
  state.sessions[session.provider] = session.id;
  if (options.targetProvider && options.targetSessionId) state.sessions[options.targetProvider] = options.targetSessionId;
  const statePath = await writeGatewayState(cwd, state);
  // Best-effort memory indexing: pure parsing (token-free) and silent on
  // runtimes without node:sqlite; checkpoint creation never depends on it.
  await indexCheckpointBestEffort(cwd, manifest, messages, directory);
  return { manifest, directory, handoffPath, transcriptPath, patchPath, statePath };
}
