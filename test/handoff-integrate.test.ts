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

test("re-running integrate upgrades a pre-existing hook entry in place instead of leaving it stale", async () => {
  const cwd = await fixture("simem-integrate-upgrade-");
  await mkdir(join(cwd, ".codex"), { recursive: true });
  // Simulates a project integrated before statusMessage existed: the command
  // matches exactly, but the entry predates the new field.
  await writeFile(
    join(cwd, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: {
        PreCompact: [{ hooks: [{ type: "command", command: "simem hook pre-compact --provider codex" }] }],
      },
    }),
  );
  const plan = await integrateProvider(cwd, "codex");
  const hooksEntry = plan.files.find((file) => file.path.endsWith("hooks.json"));
  assert.equal(hooksEntry?.action, "updated", "a stale entry must be rewritten, not silently left alone");

  const hooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  const entry = hooks.hooks.PreCompact[0].hooks[0];
  assert.equal(entry.command, "simem hook pre-compact --provider codex", "the command itself is untouched");
  assert.equal(entry.statusMessage, "simem: checkpoint before compaction");

  // Running it again now must be a true no-op.
  const second = await integrateProvider(cwd, "codex");
  const secondHooksEntry = second.files.find((file) => file.path.endsWith("hooks.json"));
  assert.equal(secondHooksEntry?.action, "unchanged");
});

test("claude integrate writes hooks, .mcp.json, and instruction block; second run is a no-op", async () => {
  const cwd = await fixture("simem-integrate-claude-");
  const first = await integrateProvider(cwd, "claude");
  const byFile = actions(first);
  assert.equal(byFile[".claude/settings.json"], "created");

  const settings = JSON.parse(await readFile(join(cwd, ".claude", "settings.json"), "utf8"));
  for (const event of ["SessionStart", "PreCompact", "UserPromptSubmit", "Stop"]) {
    const entry = settings.hooks[event][0].hooks[0];
    assert.match(entry.command as string, /^simem hook (session-start|pre-compact|user-prompt-submit|stop) --provider claude$/);
    // statusMessage gives each hook a readable label instead of a positional
    // "Hook 1"/"Hook 2" in a host app's trust/approval UI (observed on Codex).
    assert.match(entry.statusMessage as string, /^simem:/);
  }
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "simem hook stop --provider claude");
  assert.equal(settings.hooks.Stop[0].hooks[0].statusMessage, "simem: report measured token savings");
  const mcp = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers["simem-memory"], { command: "simem", args: ["mcp", "--cwd", cwd, "--provider", "claude"] });
  const local = await readFile(join(cwd, "CLAUDE.local.md"), "utf8");
  assert.match(local, /simem:integrate:start/);
  assert.match(local, /memory_search/);
  // The handoff import block is installed alongside (double-injection guard depends on it).
  assert.match(local, /simem:handoff:start/);
  assert.match(local, /@\.simem\/current\/BRIEF\.md/);

  const second = await integrateProvider(cwd, "claude");
  assert.ok(second.files.every((file) => file.action === "unchanged"), JSON.stringify(second.files));
});

test("claude integrate preserves a user's existing hooks and MCP servers; --remove strips only simem's entries", async () => {
  const cwd = await fixture("simem-integrate-merge-");
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
  assert.ok(mcp.mcpServers["simem-memory"]);

  const removal = await integrateProvider(cwd, "claude", { remove: true });
  const settingsAfter = JSON.parse(await readFile(join(cwd, ".claude", "settings.json"), "utf8"));
  assert.equal(settingsAfter.hooks.SessionStart.length, 1);
  assert.equal(settingsAfter.hooks.SessionStart[0].hooks[0].command, "echo mine");
  assert.equal(settingsAfter.hooks.PreCompact, undefined);
  const mcpAfter = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8"));
  assert.ok(mcpAfter.mcpServers.other);
  assert.equal(mcpAfter.mcpServers["simem-memory"], undefined);
  assert.ok(removal.files.some((file) => file.action === "updated"));
});

test("malformed existing settings.json fails that file only, writes nothing over it", async () => {
  const cwd = await fixture("simem-integrate-malformed-");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), "{ this is not json");
  const plan = await integrateProvider(cwd, "claude");
  const settingsEntry = plan.files.find((file) => file.path.endsWith("settings.json"));
  assert.equal(settingsEntry?.action, "failed");
  assert.match(settingsEntry?.note ?? "", /not valid JSON/);
  assert.equal(await readFile(join(cwd, ".claude", "settings.json"), "utf8"), "{ this is not json");
  // The other files still integrated.
  assert.match(await readFile(join(cwd, ".mcp.json"), "utf8"), /simem-memory/);
});

test("codex integrate writes hooks.json, a marker-delimited TOML MCP block, and AGENTS.md", async () => {
  const cwd = await fixture("simem-integrate-codex-");
  await writeFile(join(cwd, "AGENTS.md"), "# My project\n\nExisting instructions.\n");
  const plan = await integrateProvider(cwd, "codex");
  assert.ok(plan.notes.some((note) => /trusted/.test(note)));

  const hooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.PreCompact[0].hooks[0].command, "simem hook pre-compact --provider codex");
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, "simem hook stop --provider codex");
  // Codex's trust/approval UI has no dedicated hook-name field and otherwise
  // labels entries positionally ("Hook 1", "Hook 2", ...); statusMessage is
  // the documented field that gives each one a readable label instead.
  assert.equal(hooks.hooks.PreCompact[0].hooks[0].statusMessage, "simem: checkpoint before compaction");
  assert.equal(hooks.hooks.Stop[0].hooks[0].statusMessage, "simem: report measured token savings");
  const toml = await readFile(join(cwd, ".codex", "config.toml"), "utf8");
  assert.match(toml, /# simem:integrate:start\n\[mcp_servers\.simem-memory\]/);
  const agents = await readFile(join(cwd, "AGENTS.md"), "utf8");
  assert.match(agents, /^# My project/, "user content stays first and untouched");
  assert.match(agents, /simem:integrate:start/);

  await integrateProvider(cwd, "codex", { remove: true });
  const agentsAfter = await readFile(join(cwd, "AGENTS.md"), "utf8");
  assert.doesNotMatch(agentsAfter, /simem:integrate/);
  assert.match(agentsAfter, /Existing instructions\./);
  const tomlAfter = await readFile(join(cwd, ".codex", "config.toml"), "utf8").catch(() => "");
  assert.doesNotMatch(tomlAfter, /simem-memory/);
});

test("cursor integrate writes mcp.json, best-guess hooks.json flagged unverified, and an owned rules file", async () => {
  const cwd = await fixture("simem-integrate-cursor-");
  const plan = await integrateProvider(cwd, "cursor");
  // The "unverified" caveat lives only on the specific file it applies to
  // (not duplicated as a provider-level note too — the CLI now renders
  // per-file notes inline, so a second copy at the provider level was
  // redundant noise).
  const hooksEntry = plan.files.find((file) => file.path.endsWith("hooks.json"));
  assert.match(hooksEntry?.note ?? "", /unverified/);
  assert.ok(!plan.notes.some((note) => /unverified/.test(note)), "should not duplicate the file-level note");

  const hooks = JSON.parse(await readFile(join(cwd, ".cursor", "hooks.json"), "utf8"));
  assert.equal(hooks.hooks.sessionStart[0].command, "simem hook session-start --provider cursor");
  assert.equal(hooks.hooks.beforeSubmitPrompt[0].command, "simem hook user-prompt-submit --provider cursor");
  assert.equal(hooks.hooks.stop[0].command, "simem hook stop --provider cursor");
  const rules = await readFile(join(cwd, ".cursor", "rules", "simem-memory.mdc"), "utf8");
  assert.match(rules, /alwaysApply: true/);
  assert.match(rules, /context_brief/);

  await integrateProvider(cwd, "cursor", { remove: true });
  await assert.rejects(readFile(join(cwd, ".cursor", "rules", "simem-memory.mdc"), "utf8"), /ENOENT/);
});

test("antigravity integrate writes a global GEMINI.md block honest about missing hooks", async () => {
  const cwd = await fixture("simem-integrate-ag-");
  const geminiDir = await fixture("simem-integrate-gemini-");
  const previous = process.env.GEMINI_CONFIG_DIR;
  process.env.GEMINI_CONFIG_DIR = geminiDir;
  try {
    const plan = await integrateProvider(cwd, "antigravity");
    assert.ok(plan.notes.some((note) => /no lifecycle hooks/.test(note)));
    const gemini = await readFile(join(geminiDir, "GEMINI.md"), "utf8");
    assert.match(gemini, /run `simem brief` yourself/);

    await integrateProvider(cwd, "antigravity", { remove: true });
    await assert.rejects(readFile(join(geminiDir, "GEMINI.md"), "utf8"), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_CONFIG_DIR;
    else process.env.GEMINI_CONFIG_DIR = previous;
  }
});

test("checkIntegration reports drift before integrate, clean after, dirty again after hand-editing", async () => {
  const cwd = await fixture("simem-integrate-check-");
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
  const cwd = await fixture("simem-integrate-coexist-");
  await integrateProvider(cwd, "claude");
  // Simulate the user deleting the import block but keeping everything else.
  const local = await readFile(join(cwd, "CLAUDE.local.md"), "utf8");
  const stripped = local.replace(/<!-- simem:handoff:start -->[\s\S]*<!-- simem:handoff:end -->/, "");
  await writeFile(join(cwd, "CLAUDE.local.md"), stripped);
  const check = await checkIntegration(cwd, "claude");
  assert.ok(check.notes.some((note) => /simem:handoff import block/.test(note)), JSON.stringify(check.notes));
});

test("integrate upgrades a mixai 1.x project setup in place: no mixai entries left, user content kept", async () => {
  const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const cwd = await mkdtemp(join(tmpdir(), "simem-legacy-"));
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await mkdir(join(cwd, ".codex"), { recursive: true });
  await mkdir(join(cwd, ".cursor", "rules"), { recursive: true });
  await writeFile(join(cwd, ".claude", "settings.json"), JSON.stringify({
    theme: "dark",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "mixai hook stop --provider claude" }, { type: "command", command: "say done" }] }] },
  }));
  await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { "mixai-memory": { command: "mixai" }, other: { command: "x" } } }));
  await writeFile(join(cwd, "CLAUDE.local.md"), "# Mine\n\n<!-- mixai:integrate:start -->\nold\n<!-- mixai:integrate:end -->\n");
  await writeFile(join(cwd, ".codex", "config.toml"), 'model = "gpt-5.5"\n\n# mixai:integrate:start\n[mcp_servers.mixai-memory]\ncommand = "mixai"\n# mixai:integrate:end\n');
  await writeFile(join(cwd, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mixai hook stop --provider codex" }] }] } }));
  await writeFile(join(cwd, ".cursor", "rules", "mixai-memory.mdc"), "old rules\n");

  for (const provider of ["claude", "codex", "cursor"] as const) await integrateProvider(cwd, provider);
  const files = [".claude/settings.json", ".mcp.json", "CLAUDE.local.md", ".codex/config.toml", ".codex/hooks.json", "AGENTS.md"];
  for (const file of files) {
    const text = await readFile(join(cwd, file), "utf8");
    assert.doesNotMatch(text, /mixai/, `${file} still mentions mixai`);
  }
  assert.equal(existsSync(join(cwd, ".cursor", "rules", "mixai-memory.mdc")), false);
  const settings = JSON.parse(await readFile(join(cwd, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.ok(JSON.stringify(settings.hooks.Stop).includes("say done"), "the user's own hook is kept");
  assert.ok(JSON.stringify(settings.hooks.Stop).includes("simem hook stop --provider claude"));
  const mcp = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ["other", "simem-memory"]);
  assert.match(await readFile(join(cwd, "CLAUDE.local.md"), "utf8"), /^# Mine\n/);
  assert.match(await readFile(join(cwd, ".codex", "config.toml"), "utf8"), /^model = "gpt-5\.5"\n/);

  for (const provider of ["claude", "codex", "cursor"] as const) await integrateProvider(cwd, provider, { remove: true });
  assert.equal(await readFile(join(cwd, ".codex", "config.toml"), "utf8"), 'model = "gpt-5.5"\n');
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8")).mcpServers), ["other"]);
});
