import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("Claude Code and Codex plugin manifests match the package version and share the same skills", () => {
  const pkg = read("package.json");
  const claude = read("plugin/.claude-plugin/plugin.json");
  const codex = read("plugin/.codex-plugin/plugin.json");
  assert.equal(claude.version, pkg.version);
  assert.equal(codex.version, pkg.version);
  assert.equal(claude.name, "simem");
  assert.equal(codex.name, "simem");
  assert.equal(codex.skills, "./skills/");
  assert.ok(existsSync(new URL(`../plugin/${codex.interface.logo}`, import.meta.url)));
  const skills = readdirSync(new URL("../plugin/skills/", import.meta.url));
  assert.deepEqual(skills.sort(), ["dashboard", "simem", "simem-setup", "stats"]);
  for (const skill of skills) {
    const body = readFileSync(new URL(`../plugin/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
    assert.match(body, new RegExp(`^---\\nname: ${skill}\\ndescription: .{20,300}\\n(?:[a-z-]+: .+\\n)*---\\n`), `${skill}: frontmatter`);
  }
});

test("the /simem:stats and /simem:dashboard shortcuts run only when the user asks, in both apps", () => {
  for (const skill of ["stats", "dashboard"]) {
    const body = readFileSync(new URL(`../plugin/skills/${skill}/SKILL.md`, import.meta.url), "utf8");
    assert.match(body, /\ndisable-model-invocation: true\n/, `${skill}: Claude Code`);
    const policy = readFileSync(new URL(`../plugin/skills/${skill}/agents/openai.yaml`, import.meta.url), "utf8");
    assert.match(policy, /^policy:\n  allow_implicit_invocation: false\n$/, `${skill}: Codex`);
  }
});

test("the setup skill pins the CLI to this release and asks before changing anything", () => {
  const pkg = read("package.json");
  const body = readFileSync(new URL("../plugin/skills/simem-setup/SKILL.md", import.meta.url), "utf8");
  assert.ok(body.includes(`npm install -g @simem/cli@${pkg.version}\``), "install command pinned to package.json version");
  assert.doesNotMatch(body, /@latest/);
  assert.match(body, /simem init --check/);
  assert.match(body, /only after they say yes/);
});

test("both marketplaces point at the plugin folder", () => {
  const claude = read(".claude-plugin/marketplace.json");
  const codex = read(".agents/plugins/marketplace.json");
  assert.equal(claude.plugins[0].source, "./plugin");
  assert.deepEqual(codex.plugins[0].source, { source: "local", path: "./plugin" });
});
