import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Approximates whether Claude Code would auto-approve a Bash command, so the
// PreToolUse hook only rewrites (which requires "allow") commands that would
// have been allowed anyway. Conservative by design: anything uncertain — a
// compound command, an ask/deny match, an unknown rule shape — means "no".

interface Rules {
  allow: string[];
  deny: string[];
  ask: string[];
}

function readRules(path: string): Rules {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { permissions?: Partial<Record<keyof Rules, unknown>> };
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
    return { allow: list(parsed.permissions?.allow), deny: list(parsed.permissions?.deny), ask: list(parsed.permissions?.ask) };
  } catch {
    return { allow: [], deny: [], ask: [] };
  }
}

export function settingsFiles(cwd: string): string[] {
  const home = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return [join(home, "settings.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")];
}

// "Bash(npm test)", "Bash(npm run test:*)", "Bash(git log *)", "Bash".
export function bashRuleMatches(rule: string, command: string): boolean {
  if (rule === "Bash" || rule === "Bash(*)") return true;
  const inner = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (inner === undefined) return false;
  if (inner.endsWith(":*")) {
    const prefix = inner.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (inner.includes("*")) {
    const pattern = new RegExp(`^${inner.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return pattern.test(command);
  }
  return command === inner;
}

const SHELL_OPERATORS = /[;&|`<>]|\$\(|\n/;

export function isSimpleCommand(command: string): boolean {
  return !SHELL_OPERATORS.test(command);
}

export function wouldAutoApprove(command: string, permissionMode: string | undefined, cwd: string): boolean {
  if (!isSimpleCommand(command)) return false;
  if (permissionMode === "plan") return false;
  const rules = settingsFiles(cwd).map(readRules);
  const any = (kind: keyof Rules) => rules.some((set) => set[kind].some((rule) => bashRuleMatches(rule, command)));
  if (any("deny") || any("ask")) return false;
  if (permissionMode === "bypassPermissions") return true;
  return any("allow");
}
