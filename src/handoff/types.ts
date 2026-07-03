import type { ProviderId } from "../types.js";

export interface SessionInfo {
  provider: ProviderId;
  id: string;
  path: string;
  cwd: string;
  modifiedAt: string;
  createdAt?: string;
  origin?: string;
}

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

export interface WorkspaceSnapshot {
  branch?: string;
  head?: string;
  status: string;
  diff: string;
  recentCommits: string;
}

export interface CheckpointManifest {
  version: 1;
  id: string;
  createdAt: string;
  workspace: string;
  source: {
    provider: ProviderId;
    sessionId: string;
    sessionPath: string;
    sessionModifiedAt: string;
  };
  lineage: {
    mode: "export" | "switch" | "fork";
    parentCheckpointId?: string;
  };
  target?: {
    provider: ProviderId;
    sessionId?: string;
  };
  workspaceSnapshot: {
    branch?: string;
    head?: string;
    dirty: boolean;
  };
  artifacts: {
    handoff: string;
    transcript: string;
    patch: string;
    status: string;
  };
}

export interface GatewayState {
  version: 1;
  currentCheckpointId?: string;
  checkpoints: Record<string, string>;
  sessions: Partial<Record<ProviderId, string>>;
}

export interface CreatedCheckpoint {
  manifest: CheckpointManifest;
  directory: string;
  handoffPath: string;
  transcriptPath: string;
  patchPath: string;
  statePath: string;
}
