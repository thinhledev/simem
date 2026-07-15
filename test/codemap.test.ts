import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { outlineFile, outlineText } from "../src/codemap/outline.js";
import { findReferences } from "../src/codemap/references.js";
import { handleRequest } from "../src/memory/mcp-server.js";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/process.js";

const NUL = String.fromCharCode(0);

class LsFilesRunner implements CommandRunner {
  constructor(private readonly files: string[]) {}
  async run(spec: CommandSpec): Promise<CommandResult> {
    if (spec.command === "git" && (spec.args ?? [])[0] === "ls-files") {
      return { exitCode: 0, stdout: `${this.files.join(NUL)}${NUL}`, stderr: "", durationMs: 1, timedOut: false };
    }
    return { exitCode: 1, stdout: "", stderr: "", durationMs: 1, timedOut: false };
  }
}

const deps = (runner: CommandRunner) => ({ runner, memoryConfig: DEFAULT_CONFIG.memory });

test("outlineText extracts TS symbols with kinds and line numbers", () => {
  const src = [
    "export class Widget {", // 1
    "  build(): void {}", // 2
    "}", // 3
    "export interface Props {}", // 4
    "export type Id = string;", // 5
    "export function makeId() {}", // 6
    "const handler = () => {};", // 7
  ].join("\n");
  const byName = Object.fromEntries(outlineText(src, "typescript").symbols.map((s) => [s.name, s]));
  assert.equal(byName.Widget.kind, "class");
  assert.equal(byName.Widget.line, 1);
  assert.equal(byName.build.kind, "method");
  assert.equal(byName.Props.kind, "interface");
  assert.equal(byName.Id.kind, "type");
  assert.equal(byName.makeId.kind, "function");
  assert.equal(byName.handler.kind, "function");
});

test("outlineFile detects language and reads from disk (python)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codemap-outline-"));
  await writeFile(join(dir, "app.py"), "class Foo:\n    def bar(self):\n        pass\n");
  const outline = await outlineFile(dir, "app.py");
  assert.equal(outline.language, "python");
  assert.equal(outline.backend, "heuristic");
  assert.deepEqual(
    outline.symbols.map((s) => s.name).sort(),
    ["Foo", "bar"],
  );
});

test("findReferences returns complete, word-boundary file:line matches over tracked files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codemap-refs-"));
  await mkdir(join(dir, "hooks"));
  // Lines contain spaces — a regression here (NUL scanned as a space) would skip
  // every text file and return nothing, so this doubles as a NUL-constant check.
  await writeFile(join(dir, "a.ts"), "const useSubscription = 1;\n// call useSubscription here\n");
  await writeFile(join(dir, "hooks", "b.ts"), "import { useSubscription } from '../a';\n");
  await writeFile(join(dir, "c.ts"), "const other = useSubscriptionX;\n"); // must NOT match (boundary)

  const result = await findReferences(new LsFilesRunner(["a.ts", "hooks/b.ts", "c.ts"]), dir, "useSubscription");
  assert.equal(result.total, 3); // a.ts x2 + hooks/b.ts x1
  assert.equal(result.fileCount, 2);
  assert.ok(!result.references.some((r) => r.file === "c.ts"));
});

test("findReferences rejects non-identifier symbols", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codemap-refs-bad-"));
  await assert.rejects(() => findReferences(new LsFilesRunner([]), dir, "foo(bar"), /bare identifier/);
});

test("findReferences falls back to a directory walk when git is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codemap-refs-walk-"));
  await writeFile(join(dir, "x.ts"), "const target = 1;\n");
  const noGit: CommandRunner = {
    async run() {
      return { exitCode: 128, stdout: "", stderr: "not a git repo", durationMs: 1, timedOut: false };
    },
  };
  const result = await findReferences(noGit, dir, "target");
  assert.equal(result.total, 1);
  assert.equal(result.references[0].file, "x.ts");
});

test("MCP exposes and dispatches code_outline and code_find_references (no memory DB needed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codemap-mcp-"));
  await writeFile(join(dir, "m.ts"), "export function alpha() {}\nexport const beta = () => alpha();\n");
  const runner = new LsFilesRunner(["m.ts"]);

  const list = await handleRequest(undefined, dir, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), deps(runner));
  const names = (list!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  assert.ok(names.includes("code_outline"));
  assert.ok(names.includes("code_find_references"));

  const outlineResp = await handleRequest(
    undefined,
    dir,
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "code_outline", arguments: { path: "m.ts" } } }),
    deps(runner),
  );
  const outline = JSON.parse((outlineResp!.result as { content: Array<{ text: string }> }).content[0].text);
  assert.deepEqual(
    outline.symbols.map((s: { name: string }) => s.name).sort(),
    ["alpha", "beta"],
  );

  const refsResp = await handleRequest(
    undefined,
    dir,
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "code_find_references", arguments: { symbol: "alpha" } } }),
    deps(runner),
  );
  const refs = JSON.parse((refsResp!.result as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(refs.total, 2); // definition + call inside beta
});
