import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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

function gatewayDirectory(cwd: string): string {
  return join(resolve(cwd), ".cag");
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

function recentContext(messages: TranscriptMessage[], count = 8): string {
  return messages
    .slice(-count)
    .map((message) => `### ${message.role === "user" ? "User" : "Assistant"}\n\n${message.text}`)
    .join("\n\n");
}

function latestText(messages: TranscriptMessage[], role: TranscriptMessage["role"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === role) return message.text;
  }
  return "Not available in the local transcript.";
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

${recentContext(input.messages)}
`;
}

export interface CreateCheckpointOptions {
  mode: "export" | "switch" | "fork";
  targetProvider?: ProviderId;
  targetSessionId?: string;
  note?: string;
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
  };

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
  });
  const transcript = formatTranscript(messages, session);
  const patch = `${workspace.diff}\n`;
  const status = `${workspace.status}\n`;
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all([
    writeFile(handoffPath, handoff, "utf8"),
    writeFile(transcriptPath, transcript, "utf8"),
    writeFile(patchPath, patch, "utf8"),
    writeFile(statusPath, status, "utf8"),
    writeFile(join(directory, "manifest.json"), manifestJson, "utf8"),
    writeFile(join(gatewayDirectory(cwd), "CURRENT.md"), handoff, "utf8"),
    writeFile(join(currentDirectory, handoffName), handoff, "utf8"),
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
  return { manifest, directory, handoffPath, transcriptPath, patchPath, statePath };
}
