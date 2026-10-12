// Labelled retrieval set used by `simem eval` (and CI) to measure the
// automatic-injection gate and calibrate the vector cutoffs per model.
// Memories are realistic project facts; each query names the memory it should
// surface, or null when nothing should be injected. "kind" separates exact
// keyword questions, reworded ones (little or no shared vocabulary), and
// off-topic/filler prompts that must inject nothing.

export interface EvalMemory {
  key: string;
  text: string;
}

export interface EvalQuery {
  query: string;
  expect: string | null;
  kind: "exact" | "reworded" | "negative";
}

export const EVAL_MEMORIES: EvalMemory[] = [
  { key: "handoff-import", text: "Claude Desktop handoff loading is implemented through a managed CLAUDE.local.md import of the current HANDOFF.md." },
  { key: "cowork", text: "Passing a project folder to `open -a Claude` routes Claude Desktop to Cowork instead of Code." },
  { key: "postgres", text: "We decided to use Postgres instead of MongoDB for persistence because we need transactions." },
  { key: "pnpm", text: "Always use pnpm, never npm or yarn, for installing packages in this workspace." },
  { key: "no-master", text: "Never commit directly to master; every change goes through a pull request." },
  { key: "dist", text: "Generated files in dist/ must not be committed to the repository." },
  { key: "pino", text: "Logging uses pino with JSON output in production and pretty printing locally." },
  { key: "auth", text: "Authentication uses OAuth2 with short-lived access tokens and rotating refresh tokens." },
  { key: "deploy", text: "Deploys run only from CI on a merge to main; manual deploys from laptops are forbidden." },
  { key: "codex-trust", text: "Codex asks the user to trust each hook once; trust is tied to the hook's content hash." },
  { key: "node-version", text: "simem requires Node.js 22.5 or newer because memory uses the built-in node:sqlite module." },
  { key: "rate-limit", text: "The public API is rate limited to 100 requests per minute per API key with a token bucket." },
  { key: "dates", text: "All timestamps are stored in UTC as ISO 8601 strings and converted to local time only in the UI." },
  { key: "flaky-upload", text: "The flaky upload test was fixed by awaiting the stream before asserting on the file size." },
  { key: "readme", text: "The README should explain user benefits before technical details." },
  { key: "tests-before-release", text: "Always run the full test suite before bumping the version or publishing." },
  { key: "vectors", text: "Vectors are stored inside memory.db and searched with an exact brute-force scan." },
  { key: "antigravity", text: "Antigravity has no lifecycle hooks and only reads global instructions from GEMINI.md." },
  { key: "cache", text: "Product pages are cached in Redis for five minutes and invalidated on every price change." },
  { key: "i18n", text: "User-facing strings live in locale JSON files; English is the source language for translators." },
];

export const EVAL_QUERIES: EvalQuery[] = [
  // Exact: the user's words overlap the memory.
  { query: "why did we decide to use a CLAUDE.local.md import for the Claude Desktop handoff", expect: "handoff-import", kind: "exact" },
  { query: "why does open -a Claude go to Cowork", expect: "cowork", kind: "exact" },
  { query: "did we pick Postgres or MongoDB?", expect: "postgres", kind: "exact" },
  { query: "should I install packages with npm or pnpm here", expect: "pnpm", kind: "exact" },
  { query: "can I commit directly to master", expect: "no-master", kind: "exact" },
  { query: "how is the API rate limited", expect: "rate-limit", kind: "exact" },
  { query: "which Node.js version does simem require", expect: "node-version", kind: "exact" },
  { query: "how are Codex hooks trusted", expect: "codex-trust", kind: "exact" },
  { query: "how long are product pages cached in Redis", expect: "cache", kind: "exact" },
  { query: "does Antigravity support lifecycle hooks", expect: "antigravity", kind: "exact" },
  // Reworded: same intent, different vocabulary.
  { query: "why does the app open the wrong window when I pass a folder", expect: "cowork", kind: "reworded" },
  { query: "which database are we using and why", expect: "postgres", kind: "reworded" },
  { query: "what package manager should I use", expect: "pnpm", kind: "reworded" },
  { query: "how do I ship to production", expect: "deploy", kind: "reworded" },
  { query: "how do users log in", expect: "auth", kind: "reworded" },
  { query: "what logger do we use", expect: "pino", kind: "reworded" },
  { query: "how should I store times and time zones", expect: "dates", kind: "reworded" },
  { query: "where do embeddings live", expect: "vectors", kind: "reworded" },
  { query: "is the build output tracked in git", expect: "dist", kind: "reworded" },
  { query: "how do we handle translations", expect: "i18n", kind: "reworded" },
  { query: "what must happen before a release", expect: "tests-before-release", kind: "reworded" },
  { query: "what was wrong with the intermittent upload spec", expect: "flaky-upload", kind: "reworded" },
  // Negative: nothing should be injected.
  { query: "yes, continue", expect: null, kind: "negative" },
  { query: "thanks, that looks great", expect: null, kind: "negative" },
  { query: "fix the failing test in the router", expect: null, kind: "negative" },
  { query: "let's deploy the handoff service to kubernetes", expect: null, kind: "negative" },
  { query: "write a haiku about autumn", expect: null, kind: "negative" },
  { query: "rename the variable foo to bar in utils", expect: null, kind: "negative" },
  { query: "add dark mode to the settings page", expect: null, kind: "negative" },
  { query: "what is the capital of France", expect: null, kind: "negative" },
  { query: "explain how promises work in JavaScript", expect: null, kind: "negative" },
  { query: "bump the copyright year in the footer", expect: null, kind: "negative" },
];
