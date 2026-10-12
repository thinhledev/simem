import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

// Dependency-free structural outline. mixai ships zero runtime dependencies and
// must run on any Node >= 20 with no build step, so this uses line-scan
// heuristics rather than a native/WASM parser (tree-sitter) — the outline is
// approximate but free of install/compile risk, which is the priority for a
// tool users drop onto arbitrary machines. The `backend` field leaves room for
// a precise parser to be slotted in later behind the same API.

export interface OutlineSymbol {
  name: string;
  kind: string;
  line: number;
}

export interface Outline {
  file: string;
  language: string;
  backend: "heuristic";
  symbols: OutlineSymbol[];
  truncated: boolean;
}

const MAX_SYMBOLS = 500;

interface Rule {
  re: RegExp;
  kind: string;
  /** 1-based capture group holding the symbol name (default 1). */
  name?: number;
}

// Ordered per line: the first rule that matches wins, so put more specific
// declarations before broader ones.
const TS_JS: Rule[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: "type" },
  { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum" },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function" },
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
    kind: "function",
  },
  // Indented, params, opening brace/return-type → a class/object method.
  {
    // Control-flow statements share the `name(...) {` shape; never report them.
    re: /^\s+(?:(?:public|private|protected|readonly|static|async|get|set|override)\s+)*\*?\s*(?!(?:if|for|while|switch|catch|with|return|else|do|try|await|new|typeof|function)\b)([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;{]*\)\s*(?::[^={;]+)?\{/,
    kind: "method",
  },
];

const PY: Rule[] = [
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
];

const GO: Rule[] = [
  { re: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/, kind: "func" },
  { re: /^type\s+([A-Za-z_]\w*)\s+/, kind: "type" },
];

const RUST: Rule[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "fn" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" },
  { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_][\w:]*)/, kind: "impl" },
];

const RUBY: Rule[] = [
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
  { re: /^\s*module\s+([A-Za-z_]\w*)/, kind: "module" },
  { re: /^\s*def\s+([A-Za-z_][\w?!=]*)/, kind: "method" },
];

const JVM_LIKE: Rule[] = [
  {
    re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/,
    kind: "type",
  },
];

// Cross-language fallback for extensions we don't model precisely.
const GENERIC: Rule[] = [
  { re: /^\s*(?:export\s+)?(?:pub\s+)?(?:public\s+|private\s+)?(?:async\s+)?(?:function|func|fn|def)\s+([A-Za-z_]\w*)/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:pub\s+)?(?:public\s+)?(?:class|struct|interface|trait|enum|module)\s+([A-Za-z_]\w*)/, kind: "type" },
];

const RULES: Record<string, Rule[]> = {
  typescript: TS_JS,
  javascript: TS_JS,
  python: PY,
  go: GO,
  rust: RUST,
  ruby: RUBY,
  java: JVM_LIKE,
  csharp: JVM_LIKE,
};

const EXT_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".cs": "csharp",
};

export function detectLanguage(path: string): string {
  return EXT_LANGUAGE[extname(path).toLowerCase()] ?? "unknown";
}

// Skip lines that are wholly comments so declarations mentioned in prose don't
// pollute the outline. Cheap and good enough for a heuristic.
function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

export function outlineText(source: string, language: string): { symbols: OutlineSymbol[]; truncated: boolean } {
  const rules = RULES[language] ?? GENERIC;
  const symbols: OutlineSymbol[] = [];
  const lines = source.split(/\r?\n/);
  let truncated = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed || isCommentLine(trimmed)) continue;
    for (const rule of rules) {
      const match = rule.re.exec(line);
      if (!match) continue;
      const name = match[rule.name ?? 1];
      if (name) {
        if (symbols.length >= MAX_SYMBOLS) {
          truncated = true;
        } else {
          symbols.push({ name, kind: rule.kind, line: index + 1 });
        }
      }
      break; // first matching rule wins for this line
    }
    if (truncated) break;
  }
  return { symbols, truncated };
}

export async function outlineFile(cwd: string, path: string): Promise<Outline> {
  const resolved = resolve(cwd, path);
  const source = await readFile(resolved, "utf8");
  const language = detectLanguage(resolved);
  const { symbols, truncated } = outlineText(source, language);
  return { file: path, language, backend: "heuristic", symbols, truncated };
}
