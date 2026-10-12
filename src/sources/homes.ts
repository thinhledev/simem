import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type SourceAgent = "claude" | "codex" | "cursor";

export interface AgentHome {
  agent: SourceAgent;
  dir: string;
  /** Display label, e.g. "claude:~/.claude-work". Never an account email. */
  label: string;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function tilde(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

// Sibling config dirs such as ~/.claude-work or ~/.codex-personal — the
// usual way people run a second account side by side.
function siblingDirs(prefix: string): string[] {
  const home = homedir();
  try {
    return readdirSync(home)
      .filter((name) => name.startsWith(`${prefix}-`))
      .map((name) => join(home, name))
      .filter(isDir);
  } catch {
    return [];
  }
}

export interface DiscoverOptions {
  /** Extra directories from config (`sources.extraDirs`), agent inferred from contents. */
  extraDirs?: string[];
}

// Every agent home on this machine, across accounts. With
// SIMEM_HOME_DISCOVERY=env (tests), only homes named by CLAUDE_CONFIG_DIR /
// CODEX_HOME / CURSOR_CONFIG_DIR are used.
export function discoverHomes(options: DiscoverOptions = {}): AgentHome[] {
  const envOnly = process.env.SIMEM_HOME_DISCOVERY === "env";
  const home = homedir();
  const candidates: Array<{ agent: SourceAgent; dir: string }> = [];
  const add = (agent: SourceAgent, dir: string | undefined) => {
    if (dir) candidates.push({ agent, dir: resolve(dir) });
  };
  add("claude", process.env.CLAUDE_CONFIG_DIR);
  add("codex", process.env.CODEX_HOME);
  add("cursor", process.env.CURSOR_CONFIG_DIR);
  if (!envOnly) {
    add("claude", join(home, ".claude"));
    for (const dir of siblingDirs(".claude")) add("claude", dir);
    add("codex", join(home, ".codex"));
    for (const dir of siblingDirs(".codex")) add("codex", dir);
    add("cursor", join(home, ".cursor"));
  }
  for (const dir of options.extraDirs ?? []) {
    if (existsSync(join(dir, "projects")) && !existsSync(join(dir, "sessions"))) add("claude", dir);
    else if (existsSync(join(dir, "sessions"))) add("codex", dir);
  }
  const marker: Record<SourceAgent, string> = { claude: "projects", codex: "sessions", cursor: "projects" };
  const seen = new Set<string>();
  const homes: AgentHome[] = [];
  for (const candidate of candidates) {
    if (!isDir(join(candidate.dir, marker[candidate.agent]))) continue;
    const dir = canonical(candidate.dir);
    const key = `${candidate.agent}:${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    homes.push({ agent: candidate.agent, dir, label: `${candidate.agent}:${tilde(dir)}` });
  }
  return homes;
}

export function homesFor(agent: SourceAgent, options: DiscoverOptions = {}): AgentHome[] {
  return discoverHomes(options).filter((home) => home.agent === agent);
}
