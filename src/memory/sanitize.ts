// Redacts credentials before anything is stored in memory, injected into a
// prompt, or shown from compressed command output. Patterns favour precision:
// a false redaction only hides a string, but each one is counted so the user
// can see that it happened (`mixai stats`).

interface Pattern {
  kind: string;
  re: RegExp;
  /** Keep this many leading characters as a hint (e.g. "sk-ant-"). */
  keep?: number;
}

const PATTERNS: Pattern[] = [
  { kind: "private-key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, keep: 7 },
  { kind: "openai-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, keep: 3 },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g, keep: 4 },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, keep: 4 },
  { kind: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, keep: 5 },
  { kind: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{35}\b/g, keep: 4 },
  { kind: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g, keep: 8 },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // scheme://user:password@host — keep everything but the password.
  { kind: "url-password", re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]{3,})(@)/gi },
  // KEY=value / "key": "value" for names that are secrets by convention.
  {
    kind: "secret-assignment",
    re: /\b((?:[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*["']?)([^\s"']{8,})/g,
  },
];

export interface SanitizeResult {
  text: string;
  /** Redactions by kind; empty when nothing was redacted. */
  redactions: Record<string, number>;
}

export function sanitize(text: string): SanitizeResult {
  const redactions: Record<string, number> = {};
  let out = text;
  for (const { kind, re, keep } of PATTERNS) {
    out = out.replace(re, (match: string, ...groups: unknown[]) => {
      redactions[kind] = (redactions[kind] ?? 0) + 1;
      if (kind === "url-password") return `${groups[0] as string}[REDACTED]${groups[2] as string}`;
      if (kind === "secret-assignment") return `${groups[0] as string}[REDACTED]`;
      return `${keep ? match.slice(0, keep) : ""}[REDACTED:${kind}]`;
    });
  }
  return { text: out, redactions };
}

export function sanitizeText(text: string): string {
  return sanitize(text).text;
}
