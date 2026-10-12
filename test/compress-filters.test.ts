import assert from "node:assert/strict";
import test from "node:test";
import { classifyCommand, collapseRepeats, filterOutput } from "../src/compress/filters.js";

const ESC = "\u001b";
const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n");

// Each fixture: command, raw output, exit code, lines that MUST survive.
const FIXTURES: Array<{ name: string; command: string; raw: string; exit: number; mustKeep: string[] }> = [
  {
    name: "jest with one failure",
    command: "npx jest",
    exit: 1,
    raw: [
      many(60, (i) => `${ESC}[32m PASS ${ESC}[39m src/module${i}.test.ts`),
      " FAIL  src/billing/invoice.test.ts",
      "  ● computeInvoiceTotal › applies tax",
      "",
      "    expect(received).toBe(expected) // Object.is equality",
      "",
      "    Expected: 120",
      "    Received: 100",
      "",
      "      at Object.<anonymous> (src/billing/invoice.test.ts:12:23)",
      many(40, (i) => `  ✓ unrelated passing case ${i} (3 ms)`),
      "Test Suites: 1 failed, 60 passed, 61 total",
      "Tests:       1 failed, 340 passed, 341 total",
      "Time:        8.123 s",
    ].join("\n"),
    mustKeep: ["FAIL  src/billing/invoice.test.ts", "● computeInvoiceTotal › applies tax", "Expected: 120", "Received: 100", "at Object.<anonymous> (src/billing/invoice.test.ts:12:23)", "Tests:       1 failed, 340 passed, 341 total"],
  },
  {
    name: "vitest all green with ANSI",
    command: "pnpm test",
    exit: 0,
    raw: [many(300, (i) => `${ESC}[32m ✓${ESC}[39m src/a${i}.test.ts ${ESC}[2m(4 tests)${ESC}[22m ${ESC}[33m${i}ms${ESC}[39m`), "", " Test Files  300 passed (300)", "      Tests  1200 passed (1200)", "   Duration  12.31s"].join("\n"),
    mustKeep: ["Test Files  300 passed (300)", "Tests  1200 passed (1200)"],
  },
  {
    name: "pytest failure",
    command: "pytest -q",
    exit: 1,
    raw: [
      many(30, () => "...................................................................... [ 10%]"),
      "=================================== FAILURES ===================================",
      "______________________________ test_refund_window ______________________________",
      '  File "app/refunds.py", line 42, in refund_allowed',
      "    assert days <= 30",
      "E   AssertionError: assert 31 <= 30",
      "=========================== short test summary info ============================",
      "FAILED tests/test_refunds.py::test_refund_window - AssertionError: assert 31 <= 30",
      "========================= 1 failed, 2099 passed in 9.81s =========================",
    ].join("\n"),
    mustKeep: ["test_refund_window", 'File "app/refunds.py", line 42, in refund_allowed', "E   AssertionError: assert 31 <= 30", "FAILED tests/test_refunds.py::test_refund_window", "1 failed, 2099 passed"],
  },
  {
    name: "node:test failure",
    command: "npm test",
    exit: 1,
    raw: [many(200, (i) => `✔ passing behaviour number ${i} (0.5ms)`), "✖ rejects an expired token (2.1ms)", "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "  true !== false", "ℹ tests 201", "ℹ pass 200", "ℹ fail 1"].join("\n"),
    mustKeep: ["✖ rejects an expired token", "AssertionError [ERR_ASSERTION]", "true !== false", "ℹ fail 1"],
  },
  {
    name: "go test failure",
    command: "go test ./...",
    exit: 1,
    raw: [many(80, (i) => `=== RUN   TestCase${i}\n--- PASS: TestCase${i} (0.00s)`), "=== RUN   TestParse", "    parse_test.go:31: got 3, want 4", "--- FAIL: TestParse (0.00s)", "FAIL", "FAIL\texample.com/p\t0.012s"].join("\n"),
    mustKeep: ["parse_test.go:31: got 3, want 4", "--- FAIL: TestParse (0.00s)", "FAIL\texample.com/p\t0.012s"],
  },
  {
    name: "npm install chatter",
    command: "npm install",
    exit: 0,
    raw: [many(120, (i) => `npm WARN deprecated pkg${i}@1.0.0: no longer supported`), many(50, (i) => `npm http fetch GET 200 https://registry.npmjs.org/pkg${i} 12ms`), "", "added 812 packages, and audited 813 packages in 14s", "", "4 vulnerabilities (2 moderate, 2 high)"].join("\n"),
    mustKeep: ["added 812 packages, and audited 813 packages in 14s", "4 vulnerabilities (2 moderate, 2 high)"],
  },
  {
    name: "tsc errors",
    command: "npx tsc --noEmit",
    exit: 2,
    raw: [
      many(150, (i) => `src/generated/file${i}.ts(1,1): error TS6133: 'x' is declared but its value is never read.`),
      "src/billing/invoice.ts(4,10): error TS2322: Type 'string' is not assignable to type 'number'.",
      "Found 151 errors in 151 files.",
    ].join("\n"),
    mustKeep: ["src/billing/invoice.ts(4,10): error TS2322: Type 'string' is not assignable to type 'number'.", "Found 151 errors in 151 files."],
  },
];

test("every filter keeps all failure information (golden fixtures)", () => {
  for (const fixture of FIXTURES) {
    const { text } = filterOutput(fixture.command, fixture.raw, fixture.exit);
    for (const line of fixture.mustKeep) assert.ok(text.includes(line), `${fixture.name}: dropped "${line}"\n---\n${text}`);
    assert.ok(!text.includes(ESC), `${fixture.name}: ANSI codes left in`);
  }
});

test("median reduction across the fixture corpus is at least 60%", () => {
  const ratios = FIXTURES.map((fixture) => 1 - filterOutput(fixture.command, fixture.raw, fixture.exit).text.length / fixture.raw.length).sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)]!;
  assert.ok(median >= 0.6, `median reduction ${(median * 100).toFixed(0)}% (${ratios.map((r) => (r * 100).toFixed(0)).join(", ")})`);
});

test("classifies commands and collapses repeated lines without touching failures", () => {
  assert.equal(classifyCommand("npm run test -- --watch=false"), "test");
  assert.equal(classifyCommand("pnpm install"), "install");
  assert.equal(classifyCommand("npx tsc --noEmit"), "build");
  assert.equal(classifyCommand("git log --oneline"), "git-log");
  assert.equal(classifyCommand("ls -la"), "generic");
  assert.deepEqual(collapseRepeats(["a 1", "a 2", "a 3", "a 4", "a 5", "b"]), ["a 1", "  … 3 similar line(s) …", "a 5", "b"]);
  const errors = ["Error: boom 1", "Error: boom 2", "Error: boom 3", "Error: boom 4"];
  assert.deepEqual(collapseRepeats(errors), errors, "failure lines are never collapsed");
});
