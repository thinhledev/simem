// simem was called mixai until 2.0. Everything here exists only so a mixai
// 1.x setup upgrades cleanly: its in-repo store is migrated, and the files
// its `mixai integrate` wrote are recognised and replaced (never duplicated).

/** 1.x in-repo store: <repo>/.mixai/{memory.db,checkpoints,current,state.json}. */
export const LEGACY_DIR = ".mixai";

export const LEGACY_MD_START = "<!-- mixai:integrate:start -->";
export const LEGACY_MD_END = "<!-- mixai:integrate:end -->";
export const LEGACY_TOML_START = "# mixai:integrate:start";
export const LEGACY_TOML_END = "# mixai:integrate:end";
export const LEGACY_HANDOFF_START = "<!-- mixai:handoff:start -->";
export const LEGACY_HANDOFF_END = "<!-- mixai:handoff:end -->";

/** 1.x MCP server registration name (.mcp.json, .cursor/mcp.json, [mcp_servers.*]). */
export const LEGACY_MCP_SERVER = "mixai-memory";

/** 1.x Cursor rules file. */
export const LEGACY_CURSOR_RULES = "mixai-memory.mdc";

/** A hook command written by 1.x `mixai integrate`. */
export function isLegacyHookCommand(command: unknown): boolean {
  return typeof command === "string" && /^mixai hook [a-z-]+ --provider [a-z]+$/.test(command.trim());
}

/** Any 1.x integration marker or entry in a file's content. */
export const LEGACY_INTEGRATION_PATTERN = /mixai hook |mixai-memory|mixai:integrate:start|mixai:handoff:start/;

// Removes a marker-delimited block (and the blank line before it) if present.
export function stripMarkedBlock(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) return text;
  return `${text.slice(0, startIndex)}${text.slice(endIndex + end.length)}`.replace(/\n{3,}/g, "\n\n");
}
