// Output filters for `simem exec`. Contract, enforced by golden tests:
// failure information (failing test names, error lines, assertion diffs,
// in-repo stack frames) is never dropped; only noise is — ANSI codes,
// progress bars, passing-test lines, repeated lines, install chatter.

export type FilterKind = "test" | "install" | "build" | "git-log" | "git-diff" | "generic";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][A-Z0-9]/g;

// Never dropped by any filter.
export const FAILURE_LINE = /\b(error|errors|failed|failure|failing|fail|exception|panic|traceback|assert|expected|received|undefined is not|cannot find|not found|denied|fatal|segmentation fault|timed? ?out)\b|✖|✗|✘|\bFAIL\b|\bnot ok\b|^\s*at .+:\d+:\d+\)?$|^\s*File ".+", line \d+|^\s*-{3} FAIL|^\s*[-+] /i;

const TEST_RUNNER = /\b(jest|vitest|mocha|ava|tap|pytest|py\.test|unittest|go test|cargo test|cargo nextest|rspec|phpunit|dotnet test|mvn test|gradle test|npm (?:run )?test|pnpm (?:run )?test|yarn test|bun test|node --test|deno test|npx (?:jest|vitest|mocha))\b/;
const INSTALL = /\b(npm (?:install|i|ci|add)|pnpm (?:install|i|add)|yarn(?: install| add)?$|yarn (?:install|add)|pip3? install|poetry install|bundle install|cargo fetch|go mod download|composer install|bun install)\b/;
const BUILD = /\b(tsc|eslint|webpack|vite build|next build|npm run build|pnpm (?:run )?build|yarn build|cargo build|cargo check|go build|go vet|make|gradle build|mvn (?:package|compile)|dotnet build|ruff|mypy|pyright|biome|prettier --check)\b/;

export function classifyCommand(command: string): FilterKind {
  const c = command.trim();
  if (TEST_RUNNER.test(c)) return "test";
  if (INSTALL.test(c)) return "install";
  if (BUILD.test(c)) return "build";
  if (/^git\s+(?:--no-pager\s+)?log\b/.test(c)) return "git-log";
  if (/^git\s+(?:--no-pager\s+)?(?:diff|show)\b/.test(c)) return "git-diff";
  return "generic";
}

// Commands worth wrapping at all: the ones that are reliably noisy.
export function isNoisyCommand(command: string): boolean {
  return classifyCommand(command) !== "generic";
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

// Carriage-return redraws (progress bars) keep only their final state.
function resolveCarriageReturns(line: string): string {
  const parts = line.split("\r");
  return parts.filter((part) => part.length > 0).at(-1) ?? "";
}

const PROGRESS = /^\s*(?:\[[=#>\-.\s]{10,}\]|[=#>]{10,}|[█▓▒░■□▏▎▍▌▋▊▉]{6,}|\d{1,3}(?:\.\d+)?%(?:\s|$)|[⠁-⣿]\s|\(\d+\/\d+\)\s*$)/;

function similarityKey(line: string): string {
  return line.replace(/\d+(?:\.\d+)?/g, "#").replace(/\s+/g, " ").trim();
}

// Runs of identical (or digit-only-different) lines collapse to the first
// and last with a count.
export function collapseRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const key = similarityKey(lines[index] ?? "");
    let end = index + 1;
    while (end < lines.length && similarityKey(lines[end] ?? "") === key) end += 1;
    const run = end - index;
    if (run >= 4 && !FAILURE_LINE.test(lines[index] ?? "")) {
      out.push(lines[index] ?? "", `  … ${run - 2} similar line(s) …`, lines[end - 1] ?? "");
    } else {
      out.push(...lines.slice(index, end));
    }
    index = end;
  }
  return out;
}

const PASSING_TEST_LINE = /^\s*(?:✓|✔|√|ok \d+|PASS\b|PASSED\b|\.+$|test .+ \.\.\. ok$|--- PASS|=== RUN|=== PAUSE|=== CONT|▶ |✓ |\s*\(pass\))|\b(?:passed|PASSED)\s*$/;
const TEST_SUMMARY = /\b(\d+ (?:passed|failed|passing|failing|pending|skipped|tests?|suites?|todo|errors?))\b|^\s*(?:Tests?|Test Suites|Test Files|Snapshots|Time|Duration|Ran \d+|ℹ (?:tests|pass|fail|suites|duration_ms))\b|^(?:ok|FAIL|PASS)\s+\S+\s+[\d.]+s$|^test result:|^=+ .*(?:passed|failed).* =+$/i;

function filterTest(lines: string[], exitCode: number | null): string[] {
  if (exitCode === 0) {
    // All green: the counts are the information.
    const summary = lines.filter((line) => TEST_SUMMARY.test(line) || FAILURE_LINE.test(line));
    return summary.length > 0 ? summary : lines.slice(-8);
  }
  return lines.filter((line) => !PASSING_TEST_LINE.test(line) || FAILURE_LINE.test(line));
}

const INSTALL_NOISE = /^(?:npm (?:WARN|notice|http)|npm verb|Progress: resolved|Already up-to-date|Downloading|Collecting|Using cached|Requirement already satisfied|  Downloading|  Using cached|Fetching|Resolving|Linking|\s*[+-] \S+@|Packages: [+-]|Lockfile is up to date|Done in)/;

function filterInstall(lines: string[]): string[] {
  return lines.filter((line) => !INSTALL_NOISE.test(line.trim()) || FAILURE_LINE.test(line) || /deprecated .*security|vulnerab/i.test(line));
}

function filterBuild(lines: string[]): string[] {
  // Keep diagnostics and their code frames; drop "Compiling …" chatter.
  return lines.filter((line) => !/^\s*(?:Compiling|Checking|Fresh|Downloaded|Building|Finished) /.test(line) || FAILURE_LINE.test(line));
}

export interface CapOptions {
  maxLines: number;
  headLines: number;
  tailLines: number;
}

const DEFAULT_CAP: CapOptions = { maxLines: 200, headLines: 60, tailLines: 80 };

// Keeps the head, the tail, and every failure line in between (up to a
// bound), marking what was omitted.
export function capLines(lines: string[], cap: CapOptions = DEFAULT_CAP): string[] {
  if (lines.length <= cap.maxLines) return lines;
  const head = lines.slice(0, cap.headLines);
  const tail = lines.slice(-cap.tailLines);
  const middle = lines.slice(cap.headLines, lines.length - cap.tailLines);
  const failures = middle.filter((line) => FAILURE_LINE.test(line)).slice(0, cap.maxLines);
  const omitted = middle.length - failures.length;
  return [...head, `  … ${omitted} line(s) omitted …`, ...failures, ...(failures.length ? ["  …"] : []), ...tail];
}

export interface FilterResult {
  text: string;
  kind: FilterKind;
}

export function filterOutput(command: string, raw: string, exitCode: number | null): FilterResult {
  const kind = classifyCommand(command);
  let lines = stripAnsi(raw)
    .split("\n")
    .map(resolveCarriageReturns)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !PROGRESS.test(line) || FAILURE_LINE.test(line));
  // Blank-line runs → one blank line.
  lines = lines.filter((line, index) => line !== "" || lines[index - 1] !== "");
  if (kind === "test") lines = filterTest(lines, exitCode);
  else if (kind === "install") lines = filterInstall(lines);
  else if (kind === "build") lines = filterBuild(lines);
  else if (kind === "git-log") lines = lines.slice(0, 120);
  lines = capLines(collapseRepeats(lines), kind === "git-diff" ? { maxLines: 400, headLines: 300, tailLines: 60 } : DEFAULT_CAP);
  return { text: lines.join("\n").trim(), kind };
}
