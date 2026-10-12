import assert from "node:assert/strict";
import test from "node:test";
import { distillWithRules, extractRuleItems, ruleSummary, splitSentences } from "../src/memory/distill/rules.js";
import type { MemoryCategory } from "../src/memory/types.js";

// Labelled corpus: each user message is either a durable statement a later
// session should know (with its expected category), or something the rules
// tier must NOT turn into memory (null). Mixes clean phrasing, non-native
// phrasing, and the traps the rules are known to be prone to.
const CORPUS: Array<[string, MemoryCategory | null]> = [
  ["Never commit directly to master.", "constraint"],
  ["We must keep the public API backward compatible.", "constraint"],
  ["Don't add new runtime dependencies to this package.", "constraint"],
  ["Make sure every hook exits 0 even when memory is unavailable.", "constraint"],
  ["Always run the full test suite before bumping the version.", "constraint"],
  ["Do not make the context to token evolve forever.", "constraint"],
  ["Avoid calling remote models for memory consolidation by default.", "constraint"],
  ["The README should not mention internal phase numbers.", "constraint"],
  ["I prefer pnpm over npm for this repo.", "preference"],
  ["I'd rather keep the CLI output short and plain.", "preference"],
  ["Please use British spelling in the docs.", "preference"],
  ["I want the README to explain benefits before technical details.", "preference"],
  ["Let's use the name simem for the repo, the package, and the CLI.", "decision"],
  ["We decided to store vectors inside memory.db instead of a separate engine.", "decision"],
  ["Going forward, release notes live in CHANGELOG.md.", "decision"],
  ["Let's switch the embedding model to potion-base-8M.", "decision"],
  ["Use SQLite FTS5 rather than a custom inverted index.", "decision"],
  ["We still need to verify the Codex hooks in the desktop app later.", "todo"],
  ["TODO: add a latency benchmark for the user prompt hook.", "todo"],
  // Must be ignored.
  ["Can you explain how the router picks a provider?", null],
  ["I don't know why the build is failing.", null],
  ["Don't worry about the lint warnings for now.", null],
  ["I want to proceed to phase 2 of this project.", null],
  ["Yes, continue.", null],
  ["Please run the tests.", null],
  ["Thanks, that looks great.", null],
  ["Here is the error output from the last run:", null],
  ["It can open the Claude app but cannot open the code conversation.", null],
  ["Why does it open Cowork instead of Code?", null],
  ["I'd like to see the diff first.", null],
  ["Don't do that.", null],
  ["Ok, ship it.", null],
];

test("rules recall >= 70% of labelled durable statements at >= 85% precision", () => {
  let truePositives = 0;
  let falsePositives = 0;
  let categoryCorrect = 0;
  const positives = CORPUS.filter(([, expected]) => expected !== null).length;
  const misses: string[] = [];
  const wrong: string[] = [];
  for (const [text, expected] of CORPUS) {
    const items = extractRuleItems([{ role: "user", text }]);
    if (items.length === 0) {
      if (expected) misses.push(text);
      continue;
    }
    if (expected === null) {
      falsePositives += 1;
      wrong.push(text);
      continue;
    }
    truePositives += 1;
    if (items[0]?.category === expected) categoryCorrect += 1;
  }
  const recall = truePositives / positives;
  const precision = truePositives / (truePositives + falsePositives);
  assert.ok(recall >= 0.7, `recall ${recall.toFixed(2)}; missed: ${misses.join(" | ")}`);
  assert.ok(precision >= 0.85, `precision ${precision.toFixed(2)}; wrongly extracted: ${wrong.join(" | ")}`);
  assert.ok(categoryCorrect / truePositives >= 0.8, `category accuracy ${(categoryCorrect / truePositives).toFixed(2)}`);
});

test("only user sentences become items; assistant claims and internal prompts are ignored", () => {
  const items = extractRuleItems([
    { role: "assistant", text: "You must never deploy on Fridays." },
    { role: "user", text: "You are updating a persistent project memory store. Never drop durable facts." },
    { role: "user", text: "Never deploy the API on Fridays." },
  ]);
  assert.deepEqual(
    items.map((item) => item.text),
    ["Never deploy the API on Fridays."],
  );
});

test("a correction right after an assistant turn is kept even without a rule keyword", () => {
  const items = extractRuleItems([
    { role: "assistant", text: "I'll install it with npm." },
    { role: "user", text: "No, use pnpm for installs in this workspace." },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.text, "Use pnpm for installs in this workspace.");
  assert.equal(items[0]?.importance, 8);
});

test("pasted logs, code blocks, and tables are not mined", () => {
  const sentences = splitSentences(
    [
      "Never log raw tokens.",
      "```",
      "// you must never see this",
      "```",
      "    at Object.<anonymous> (/app/src/index.ts:12:5)",
      "| must | never |",
      "> always quoted, not stated",
    ].join("\n"),
  );
  assert.deepEqual(sentences, ["Never log raw tokens."]);
});

test("template summary has objective, latest request, outcome, files, and a milestone flag", () => {
  const { summary, milestone } = ruleSummary([
    { role: "user", text: "Fix the retry logic in the HTTP client." },
    { role: "assistant", text: "Looking at `src/http/client.ts` now." },
    { role: "user", text: "yes" },
    { role: "user", text: "Also add a test for the timeout path." },
    { role: "assistant", text: "Implemented the fix in src/http/client.ts and added test/http-client.test.ts. All 42 tests pass." },
  ]);
  assert.match(summary, /^Objective: Fix the retry logic in the HTTP client\./);
  assert.match(summary, /Latest request: Also add a test for the timeout path\./);
  assert.match(summary, /Outcome: Implemented the fix/);
  assert.match(summary, /Files: src\/http\/client\.ts, test\/http-client\.test\.ts/);
  assert.equal(milestone, true);
});

test("distillWithRules caps items per checkpoint, keeping the most important", () => {
  const text = Array.from({ length: 20 }, (_, index) => `Never touch legacy module number ${index} again.`).join("\n");
  const output = distillWithRules([{ role: "user", text: `${text}\nTODO: clean up the build scripts later.` }]);
  assert.equal(output.items.length, 12);
  assert.ok(output.items.every((item) => item.category === "constraint"), "low-importance todos are dropped first");
});
