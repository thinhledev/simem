import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { CommandRunner } from "../process.js";

// Dependency-free "find references": a word-boundary text scan over the repo's
// git-tracked files (falling back to a directory walk outside a git repo). Not
// semantic — it won't distinguish a definition from a shadowed local — but it
// returns a complete, compact reference list that a casual single-directory
// grep misses (the class of bug where a route/allowlist string lived in an
// unexpected file). Uses only Node built-ins + the injected git runner.

export interface Reference {
  file: string;
  line: number;
  text: string;
}

export interface ReferencesResult {
  symbol: string;
  total: number;
  truncated: boolean;
  fileCount: number;
  references: Reference[];
}

export interface FindReferencesOptions {
  maxResults?: number;
  /** Restrict to these file extensions (with or without the leading dot). */
  extensions?: string[];
}

const DEFAULT_MAX_RESULTS = 200;
const PER_FILE_CAP = 25;
const MAX_FILES = 5_000;
const LINE_TEXT_CAP = 200;
// ASCII NUL: the `git ls-files -z` field separator and a reliable binary-file
// marker. Built with fromCharCode so no literal control byte lives in source.
const NUL = String.fromCharCode(0);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".mixai",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
  "vendor",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cap(text: string): string {
  return text.length > LINE_TEXT_CAP ? `${text.slice(0, LINE_TEXT_CAP)}…` : text;
}

// Tracked AND untracked-but-not-ignored files: `--others --exclude-standard`
// includes files the agent just created (uncommitted), which are exactly the
// ones a mid-refactor reference search must not miss, while still honoring
// .gitignore so build output stays out.
async function trackedFiles(runner: CommandRunner, cwd: string): Promise<string[] | undefined> {
  try {
    const result = await runner.run({
      command: "git",
      args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      cwd,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.split(NUL).filter(Boolean);
  } catch {
    return undefined;
  }
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, full, out);
    } else if (entry.isFile()) {
      out.push(relative(root, full));
    }
  }
}

export async function findReferences(
  runner: CommandRunner,
  cwd: string,
  symbol: string,
  options: FindReferencesOptions = {},
): Promise<ReferencesResult> {
  if (!IDENTIFIER.test(symbol)) {
    throw new Error("symbol must be a bare identifier (letters, digits, _ or $)");
  }
  const root = resolve(cwd);
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const extFilter = options.extensions?.length
    ? new Set(options.extensions.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()))
    : undefined;

  let files = await trackedFiles(runner, root);
  if (!files) {
    files = [];
    await walk(root, root, files);
  }
  if (extFilter) files = files.filter((file) => extFilter.has(extname(file).toLowerCase()));
  files = files.slice(0, MAX_FILES);

  const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  const references: Reference[] = [];
  const fileSet = new Set<string>();
  let total = 0;

  for (const rel of files) {
    let content: string;
    try {
      content = await readFile(join(root, rel), "utf8");
    } catch {
      continue;
    }
    if (!content.includes(symbol)) continue; // fast reject
    if (content.includes(NUL)) continue; // skip binary files
    const lines = content.split(/\r?\n/);
    let perFile = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index] ?? "";
      if (!pattern.test(lineText)) continue;
      total += 1;
      if (perFile < PER_FILE_CAP && references.length < maxResults) {
        references.push({ file: rel, line: index + 1, text: cap(lineText.trim()) });
        perFile += 1;
        fileSet.add(rel);
      }
    }
  }

  return { symbol, total, truncated: total > references.length, fileCount: fileSet.size, references };
}
