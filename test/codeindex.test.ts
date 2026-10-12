import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCodeIndex } from "../src/codeindex/db.js";
import { indexRepository, shouldIndex, symbolsWithRanges } from "../src/codeindex/indexer.js";
import { codeRead, codeSearch, repoMap } from "../src/codeindex/search.js";
import { loadSqlite } from "../src/memory/db.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "simem-code-")));
  mkdirSync(join(dir, "src", "billing"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(
    join(dir, "src", "billing", "invoice.ts"),
    [
      "/** Invoice totals and tax. */",
      'import { roundCents } from "../money.js";',
      "",
      "export function computeInvoiceTotal(lines: number[]): number {",
      "  const subtotal = lines.reduce((a, b) => a + b, 0);",
      "  return roundCents(subtotal * 1.2);",
      "}",
      "",
      "export class InvoiceRenderer {",
      "  render(total: number): string {",
      "    return `Total: ${total}`;",
      "  }",
      "}",
    ].join("\n"),
  );
  writeFileSync(join(dir, "src", "money.ts"), "export function roundCents(value: number): number {\n  return Math.round(value * 100) / 100;\n}\n");
  writeFileSync(join(dir, "README.md"), "# Shop\n\nA small shop.\n");
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  return dir;
}

test("symbol ranges end before the next symbol at the same or shallower indentation", () => {
  const source = "export class A {\n  one() {\n    return 1;\n  }\n\n  two() {}\n}\n\nexport function b() {}\n";
  const symbols = symbolsWithRanges(source, "typescript");
  assert.deepEqual(
    symbols.map((symbol) => [symbol.name, symbol.start, symbol.end]),
    [["A", 1, 7], ["one", 2, 4], ["two", 6, 7], ["b", 9, 9]],
  );
});

test("skips lockfiles, dependencies, build output, and binaries", () => {
  assert.equal(shouldIndex("package-lock.json", 10), false);
  assert.equal(shouldIndex("node_modules/x/index.js", 10), false);
  assert.equal(shouldIndex("dist/cli.js", 10), false);
  assert.equal(shouldIndex("assets/logo.png", 10), false);
  assert.equal(shouldIndex("src/app.min.js", 10), false);
  assert.equal(shouldIndex("src/app.ts", 600 * 1024), false);
  assert.equal(shouldIndex("src/app.ts", 10), true);
});

test("indexes incrementally and answers code_search / code_read / repo_map without whole files", withSqlite, async () => {
  const dir = repo();
  const previous = process.env.SIMEM_STORAGE;
  process.env.SIMEM_STORAGE = "project";
  const index = openCodeIndex(dir);
  assert.ok(index);
  try {
    const first = await indexRepository(index);
    assert.equal(first.files, 4, "README, .gitignore, invoice.ts, money.ts — not the lockfile or node_modules");
    assert.ok(first.symbols >= 4);

    const second = await indexRepository(index);
    assert.equal(second.changed, 0, "nothing changed, nothing re-parsed");

    const hits = await codeSearch(index, "where is the invoice total computed");
    assert.equal(hits[0]?.path, "src/billing/invoice.ts");
    assert.equal(hits[0]?.name, "computeInvoiceTotal");
    assert.deepEqual([hits[0]?.start, hits[0]?.end], [4, 7]);
    assert.equal((await codeSearch(index, "computeInvoiceTotal"))[0]?.name, "computeInvoiceTotal");

    const span = codeRead(index, "src/billing/invoice.ts", { symbol: "InvoiceRenderer" });
    assert.match(span.text, /^\s+9 {2}export class InvoiceRenderer/);
    assert.equal(span.end, 13);
    assert.throws(() => codeRead(index, "../../etc/passwd", { start: 1 }), /outside the project/);

    const map = repoMap(index);
    assert.match(map, /src\/ 3 file\(s\)|src\/ 2 file\(s\)/);
    assert.match(map, /src\/money\.ts — exports: roundCents/, "most-imported file is a key file");

    writeFileSync(join(dir, "src", "money.ts"), "export function roundCents(value: number): number {\n  return Math.round(value);\n}\nexport const CURRENCY = 'EUR';\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    const third = await indexRepository(index);
    assert.equal(third.changed, 1, "only the edited file is re-indexed");
  } finally {
    index.close();
    process.env.SIMEM_STORAGE = previous;
  }
});
