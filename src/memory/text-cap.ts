export interface CapResult {
  text: string;
  truncated: boolean;
}

// Hard character cap with an ellipsis; breaks on the last newline when that
// stays past 60% of the budget, so a cut mid-sentence prefers a clean line
// boundary instead of an arbitrary character. Shared by HANDOFF.md assembly,
// consolidation rollups, and anywhere else text is budgeted into a prompt.
export function capText(text: string, maxChars: number): CapResult {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  const lastBreak = slice.lastIndexOf("\n");
  const cut = lastBreak > maxChars * 0.6 ? slice.slice(0, lastBreak) : slice;
  return { text: `${cut}…`, truncated: true };
}

export function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}
