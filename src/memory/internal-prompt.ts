// mixai's own consolidation and rollup prompts can land in a transcript as a
// "user" message (a headless `codex exec` / `claude -p` run is still a
// session). They must never be surfaced as the human's objective or mined for
// the human's decisions.
export function isInternalMemoryPrompt(text: string): boolean {
  return /persistent project memory store|Respond with ONLY a JSON object|compacting the long-term memory of a coding project/i.test(
    text,
  );
}
