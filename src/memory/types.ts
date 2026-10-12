export const MEMORY_KINDS = ["semantic", "episodic", "procedural"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_CATEGORIES = ["decision", "constraint", "preference", "fact", "todo"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_STATUSES = ["active", "superseded", "archived"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export interface MemoryItem {
  id: number;
  kind: MemoryKind;
  category?: MemoryCategory;
  text: string;
  importance: number;
  status: MemoryStatus;
  supersededBy?: number;
  sourceCheckpointId?: string;
  createdAt: string;
  lastReinforcedAt: string;
}

export interface Summary {
  id: number;
  level: number;
  text: string;
  coversFrom: string;
  coversTo: string;
  checkpointCount: number;
  createdAt: string;
  supersededBy?: number;
}

export interface CheckpointRow {
  id: string;
  createdAt: string;
  workspace: string;
  sourceProvider: string;
  sourceSessionId: string;
  lineageMode: string;
  parentCheckpointId?: string;
  targetProvider?: string;
  targetSessionId?: string;
  branch?: string;
  head?: string;
  dirty: boolean;
  directory: string;
  consolidationStatus: "pending" | "rules" | "done" | "skipped";
}

export interface RetrievalHit {
  source: "message" | "memory_item" | "summary";
  id: number;
  text: string;
  checkpointId?: string;
  score: number;
  relevance: number;
  recency: number;
  importance?: number;
  /** Query terms this hit contains; empty for a vector-only match. */
  matchedTerms?: string[];
}

export interface MemoryStats {
  dbPath: string;
  checkpoints: number;
  messages: number;
  memoryItems: Record<string, number>;
  summariesByLevel: Record<string, number>;
  queueDepth: number;
  fts: boolean;
  schemaVersion: number;
}

export interface ConsolidationItem {
  kind: MemoryKind;
  category?: MemoryCategory;
  text: string;
  importance: number;
  supersedes?: number;
}

export interface ConsolidationOutput {
  summary: string;
  items: ConsolidationItem[];
  /** True when the model judges this checkpoint completed a distinct, nameable objective. */
  milestone: boolean;
}

export type ConsolidationStatus = "done" | "queued" | "skipped" | "disabled";

export interface ConsolidationResult {
  status: ConsolidationStatus;
  checkpointId: string;
  itemsWritten: number;
  /** Existing items a restatement reinforced instead of duplicating. */
  itemsReinforced?: number;
  detail?: string;
}
