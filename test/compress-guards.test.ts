import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execCompressed, readOutput } from "../src/compress/exec.js";
import { decidePreToolUse } from "../src/compress/guards.js";
import { bashRuleMatches, wouldAutoApprove } from "../src/compress/permissions.js";
import { DEFAULT_CONFIG, type GatewayConfig } from "../src/config.js";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };
const config: GatewayConfig = { ...DEFAULT_CONFIG, compression: { ...DEFAULT_CONFIG.compression, rtk: "ignore" } };

function workspace(allow: string[] = [], deny: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "simem-guard-"));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow, deny } }));
  return dir;
}

test("Claude permission rule matching: exact, prefix (:*), and glob forms", () => {
  assert.equal(bashRuleMatches("Bash(npm test)", "npm test"), true);
  assert.equal(bashRuleMatches("Bash(npm test)", "npm test --watch"), false);
  assert.equal(bashRuleMatches("Bash(npm run test:*)", "npm run test -- --ci"), true);
  assert.equal(bashRuleMatches("Bash(npm run test:*)", "npm run testing"), false);
  assert.equal(bashRuleMatches("Bash(pnpm *)", "pnpm install"), true);
  assert.equal(bashRuleMatches("Read(*)", "npm test"), false);
});

test("Bash is rewritten only when the user's settings already auto-approve the command", withSqlite, async () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "simem-guard-home-"));
  try {
    const allowed = workspace(["Bash(npm test:*)"]);
    const rewrite = await decidePreToolUse({ toolName: "Bash", toolInput: { command: "npm test", description: "Run tests" }, permissionMode: "default", sessionId: "s" }, allowed, "claude", config);
    const output = rewrite?.hookSpecificOutput as { permissionDecision: string; updatedInput: { command: string; description: string } };
    assert.equal(output.permissionDecision, "allow");
    assert.match(output.updatedInput.command, /simem" exec -- 'npm test'$/);
    assert.equal(output.updatedInput.description, "Run tests", "other tool input fields are preserved");

    const ask = (dir: string, command: string, mode = "default") =>
      decidePreToolUse({ toolName: "Bash", toolInput: { command }, permissionMode: mode, sessionId: "s" }, dir, "claude", config);
    assert.equal(await ask(workspace(), "npm test"), undefined, "not in allow rules: the user's normal prompt applies");
    assert.equal(await ask(workspace(["Bash(npm test:*)"], ["Bash(npm test:*)"]), "npm test"), undefined, "deny beats allow");
    assert.equal(await ask(allowed, "npm test && rm -rf build"), undefined, "compound commands are never rewritten");
    assert.equal(await ask(allowed, "npm test", "plan"), undefined);
    assert.ok(await ask(workspace(), "npm test", "bypassPermissions"));
    assert.equal(await ask(workspace(), "ls -la", "bypassPermissions"), undefined, "only known-noisy commands");
    assert.equal(await decidePreToolUse({ toolName: "Bash", toolInput: { command: "npm test" }, permissionMode: "bypassPermissions" }, allowed, "codex", config), undefined, "Claude only");
    assert.equal(wouldAutoApprove("npm test", "default", allowed), true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("read guards: a large full read gets an outline once; an unchanged re-read is flagged once; savings withdrawn when the agent insists", withSqlite, async () => {
  const dir = workspace();
  const big = join(dir, "big.ts");
  writeFileSync(big, Array.from({ length: 900 }, (_, i) => (i % 100 === 0 ? `export function f${i}() {` : i % 100 === 99 ? "}" : `  const v${i} = ${i};`)).join("\n"));
  const small = join(dir, "small.ts");
  writeFileSync(small, "export const a = 1;\n");
  const read = (file: string, extra: Record<string, unknown> = {}, sessionId = "r1") =>
    decidePreToolUse({ toolName: "Read", toolInput: { file_path: file, ...extra }, sessionId }, dir, "claude", config);

  const first = await read(big);
  const reason = (first?.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string }) ?? {};
  assert.equal(reason.permissionDecision, "deny");
  assert.match(reason.permissionDecisionReason, /900 lines/);
  assert.match(reason.permissionDecisionReason, /1-100 {2}function f0/);
  assert.equal(await read(big, { offset: 1, limit: 100 }), undefined, "partial reads always pass");
  assert.equal(await read(big), undefined, "asking again gets the whole file");

  const memory = await openMemoryDb(dir, { quiet: true });
  assert.ok(memory);
  const savings = () => (memory.db.prepare("SELECT COUNT(*) AS n FROM savings_events WHERE mechanism = 'read-guard'").get() as { n: number }).n;
  assert.equal(savings(), 0, "the agent read it anyway, so no saving is claimed");

  assert.equal(await read(small), undefined);
  const again = await read(small);
  assert.equal((again?.hookSpecificOutput as { permissionDecision: string }).permissionDecision, "deny", "unchanged since the full read");
  assert.equal(await read(small), undefined, "only once");
  writeFileSync(small, "export const a = 2;\n// changed\n");
  assert.equal(await read(small, {}, "r2"), undefined, "another session never inherits reads");
  memory.close();
});

test("read guards leave images, PDFs and other binary files alone", withSqlite, async () => {
  const dir = workspace();
  const manyLines = "\n".repeat(2_000);
  const png = join(dir, "screenshot.png");
  writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(manyLines)]));
  const pdf = join(dir, "report.pdf");
  writeFileSync(pdf, `%PDF-1.7${manyLines}`);
  const blob = join(dir, "data.bin.cache");
  writeFileSync(blob, Buffer.concat([Buffer.from(manyLines), Buffer.from([0, 1, 2, 3])]));
  const read = (file: string) => decidePreToolUse({ toolName: "Read", toolInput: { file_path: file }, sessionId: "b1" }, dir, "claude", config);

  for (const file of [png, pdf, blob]) {
    assert.equal(await read(file), undefined, `${file}: no outline for a non-text file`);
    assert.equal(await read(file), undefined, `${file}: no re-read flag either`);
  }
  const memory = await openMemoryDb(dir, { quiet: true });
  assert.ok(memory);
  assert.equal((memory.db.prepare("SELECT COUNT(*) AS n FROM savings_events").get() as { n: number }).n, 0, "no savings claimed");
  memory.close();
});

test("simem exec keeps the exit code, passes small output through, filters and stores large output", withSqlite, async () => {
  const dir = workspace();
  const quiet = await execCompressed(["printf 'hello\\n'; exit 3"], dir);
  assert.equal(quiet.exitCode, 3);
  assert.equal(quiet.text, "hello\n");
  assert.equal(quiet.outputId, undefined);

  const script = `for i in $(seq 1 300); do echo "✔ passing case $i (1ms)"; done; echo "✖ breaks on empty input"; echo "  AssertionError: expected 1"; echo "ℹ fail 1"; exit 1`;
  const noisy = await execCompressed(["/bin/bash", "-c", script], dir);
  assert.equal(noisy.exitCode, 1);
  assert.match(noisy.text, /✖ breaks on empty input/);
  assert.match(noisy.text, /AssertionError: expected 1/);
  assert.match(noisy.text, /\[simem: [\d,]+ → [\d,]+ chars · full output: simem out [0-9a-f]{6}\]$/);
  assert.ok(noisy.text.length < noisy.raw.length / 3);
  const memory = await openMemoryDb(dir, { quiet: true });
  assert.ok(memory);
  try {
    assert.equal(readOutput(memory, noisy.outputId!)?.text, noisy.raw);
  } finally {
    memory.close();
  }
});
