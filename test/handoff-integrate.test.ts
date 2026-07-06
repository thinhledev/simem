import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkIntegration, integrateProvider } from "../src/handoff/integrate.js";

async function fixture(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

function actions(plan: Awaited<ReturnType<typeof integrateProvider>>): Record<string, string> {
  return Object.fromEntries(plan.files.map((file) => [file.path.split("/").slice(-2).join("/"), file.action]));
}

test("claude integrate writes hooks, .mcp.json, and instruction block; second run is a no-op", async () => {
  const cwd = await fixture("cag-integrate-claude-");
  const first = await integrateProvider(cwd, "claude");
  const byFile = actions(first);
  assert.equal(byFile[".claude/settings.json"], "created");

  const settings = JSON.parse(await readFile(join(cwd, ".claude", "settings.json"), "utf8"));
  for (const event of ["SessionStart", "PreCompact", "UserPromptSubmit"]) {
    const command = settings.hooks[event][0].hooks[0].command as string;
    assert.match(command, /^cag hook (session-start|pre-compact|user-prompt-submit) --provider claude$/);
  }
  const mcp = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers["cag-memory"], { command: "cag", args: ["mcp", "--cwd", cwd] });
  const local = await readFile(join(cwd, "CLAUDE.local.md"), "utf8");
  assert.match(local, /cag:integrate:start/);
  assert.match(local, /memory_search/);
  // The handoff import block is installed alongside (double-injection guard depends on it).
  assert.match(local, /cag:handoff:start/);
  assert.match(local, /@\.cag\/current\/HANDOFF\.md/);

  const second = await integrateProvider(cwd, "claude");
  assert.ok(second.files.every((file) => file.action === "unchanged"), JSON.stringify(second.files));
});

test("claude integrate preserves a user's existing hooks and MCP servers; --remove strips only cag's entries", async () => {
  const cwd = await fixture("cag-integrate-merge-");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(
    join(cwd, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
    }),
  );
  await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other-server" } } }));

  await integrateProvider(cwd, "claude");
  const settings = JSON.parse(await readFile(join(cwd, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions, { allow: ["Bash(ls:*)"] });
  assert.equal(settings.hooks.SessionStart.length, 2);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "echo mine");
  const mcp = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers.other);
  assert.ok(mcp.mcpServers["cag-memory"]);

  const removal = await integrateProvider(cwd, "claude", { remove: true });
  const settingsAfter = JSON.parse(await readFile(join(cwd, ".claude", "settings.json"), "utf8"));
  assert.equal(settingsAfter.hooks.SessionStart.length, 1);
  assert.equal(settingsAfter.hooks.SessionStart[0].hooks[0].command, "echo mine");
  assert.equal(settingsAfter.hooks.PreCompact, undefined);
  const mcpAfter = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8"));
  assert.ok(mcpAfter.mcpServers.other);
  assert.equal(mcpAfter.mcpServers["cag-memory"], undefined);
  assert.ok(removal.files.some((file) => file.action === "updated"));
});

test("malformed existing settings.json fails that file only, writes nothing over it", async () => {
  const cwd = await fixture("cag-integrate-malformed-");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), "{ this is not json");
  const plan = await integrateProvider(cwd, "claude");
  const settingsEntry = plan.files.find((file) => file.path.endsWith("settings.json"));
  assert.equal(settingsEntry?.action, "failed");
  assert.match(settingsEntry?.note ?? "", /not valid JSON/);
  assert.equal(await readFile(join(cwd, ".claude", "settings.json"), "utf8"), "{ this is not json");
  // The other files still integrated.
  assert.match(await readFile(join(cwd, ".mcp.json"), "utf8"), /cag-memory/);
});

test("codex integrate writes hooks.json, a marker-delimited TOML MCP block, and AGENTS.md", async () => {
  const cwd = await fixture("cag-integrate-codex-");
  await writeFile(join(cwd, "AGENTS.md"), "# My project\n\nExisting instructions.\n");
  const plan = await integrateProvider(cwd, "codex");
  assert.ok(plan.notes.some((note) => /trusted/.test(note)));

  const hooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.PreCompact[0].hooks[0].command, "cag hook pre-compact --provider codex");
  const toml = await readFile(join(cwd, ".codex", "config.toml"), "utf8");
  assert.match(toml, /# cag:integrate:start\n\[mcp_servers\.cag-memory\]/);
  const agents = await readFile(join(cwd, "AGENTS.md"), "utf8");
  assert.match(agents, /^# My project/, "user content stays first and untouched");
  assert.match(agents, /cag:integrate:start/);

  await integrateProvider(cwd, "codex", { remove: true });
  const agentsAfter = await readFile(join(cwd, "AGENTS.md"), "utf8");
  assert.doesNotMatch(agentsAfter, /cag:integrate/);
  assert.match(agentsAfter, /Existing instructions\./);
  const tomlAfter = await readFile(join(cwd, ".codex", "config.toml"), "utf8").catch(() => "");
  assert.doesNotMatch(tomlAfter, /cag-memory/);
});

test("cursor integrate writes mcp.json, best-guess hooks.json flagged unverified, and an owned rules file", async () => {
  const cwd = await fixture("cag-integrate-cursor-");
  const plan = await integrateProvider(cwd, "cursor");
  assert.ok(plan.notes.some((note) => /unverified/.test(note)));
  const hooksEntry = plan.files.find((file) => file.path.endsWith("hooks.json"));
  assert.match(hooksEntry?.note ?? "", /unverified/);

  const hooks = JSON.parse(await readFile(join(cwd, ".cursor", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.sessionStart[0].command, "cag hook session-start --provider cursor");
  assert.equal(hooks.hooks.beforeSubmitPrompt[0].command, "cag hook user-prompt-submit --provider cursor");
  const rules = await readFile(join(cwd, ".cursor", "rules", "cag-memory.mdc"), "utf8");
  assert.match(rules, /alwaysApply: true/);
  assert.match(rules, /context_brief/);

  await integrateProvider(cwd, "cursor", { remove: true });
  await assert.rejects(readFile(join(cwd, ".cursor", "rules", "cag-memory.mdc"), "utf8"), /ENOENT/);
});

test("antigravity integrate writes a global GEMINI.md block honest about missing hooks", async () => {
  const cwd = await fixture("cag-integrate-ag-");
  const geminiDir = await fixture("cag-integrate-gemini-");
  const previous = process.env.GEMINI_CONFIG_DIR;
  process.env.GEMINI_CONFIG_DIR = geminiDir;
  try {
    const plan = await integrateProvider(cwd, "antigravity");
    assert.ok(plan.notes.some((note) => /no lifecycle hooks/.test(note)));
    const gemini = await readFile(join(geminiDir, "GEMINI.md"), "utf8");
    assert.match(gemini, /run `cag brief` yourself/);

    await integrateProvider(cwd, "antigravity", { remove: true });
    await assert.rejects(readFile(join(geminiDir, "GEMINI.md"), "utf8"), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_CONFIG_DIR;
    else process.env.GEMINI_CONFIG_DIR = previous;
  }
});

test("checkIntegration reports drift before integrate, clean after, dirty again after hand-editing", async () => {
  const cwd = await fixture("cag-integrate-check-");
  const before = await checkIntegration(cwd, "codex");
  assert.equal(before.upToDate, false);
  assert.ok(before.drift.length > 0);

  await integrateProvider(cwd, "codex");
  const after = await checkIntegration(cwd, "codex");
  assert.equal(after.upToDate, true, JSON.stringify(after.drift));

  const agentsPath = join(cwd, "AGENTS.md");
  const content = await readFile(agentsPath, "utf8");
  await writeFile(agentsPath, content.replace("memory_search", "memory_find"));
  const dirty = await checkIntegration(cwd, "codex");
  assert.equal(dirty.upToDate, false);
});

test("claude --check warns when hooks exist but the CLAUDE.local.md handoff import block is missing", async () => {
  const cwd = await fixture("cag-integrate-coexist-");
  await integrateProvider(cwd, "claude");
  // Simulate the user deleting the import block but keeping everything else.
  const local = await readFile(join(cwd, "CLAUDE.local.md"), "utf8");
  const stripped = local.replace(/<!-- cag:handoff:start -->[\s\S]*<!-- cag:handoff:end -->/, "");
  await writeFile(join(cwd, "CLAUDE.local.md"), stripped);
  const check = await checkIntegration(cwd, "claude");
  assert.ok(check.notes.some((note) => /cag:handoff import block/.test(note)), JSON.stringify(check.notes));
});
