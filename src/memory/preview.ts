import type { RetrievalHit } from "./types.js";

export const DEFAULT_PREVIEW_CHARS = 240;

export interface HitPreview {
  source: RetrievalHit["source"];
  id: number;
  preview: string;
  checkpointId?: string;
  score: number;
  truncated: boolean;
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

// Progressive disclosure: callers default to this instead of RetrievalHit's
// full text, so an agent (over MCP or the CLI) gets a cheap taste of each
// result and can drill down via memory_get for the ones that matter, instead
// of paying for every hit's complete text up front.
export function toPreview(hit: RetrievalHit, maxChars = DEFAULT_PREVIEW_CHARS): HitPreview {
  const flattened = oneLine(hit.text);
  const truncated = flattened.length > maxChars;
  const preview = truncated ? `${flattened.slice(0, maxChars - 1)}…` : flattened;
  return {
    source: hit.source,
    id: hit.id,
    preview,
    ...(hit.checkpointId ? { checkpointId: hit.checkpointId } : {}),
    score: hit.score,
    truncated,
  };
}
