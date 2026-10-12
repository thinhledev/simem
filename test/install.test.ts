import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cliEntry, launcherScript } from "../src/install/launcher.js";
import { installUserLevel, userLevelCovers } from "../src/install/user-level.js";
import { stableHomebrewPath } from "../src/runtime.js";
import { claudeHome, codexHome } from "./helpers/transcripts.js";

async function withHomes<T>(fn: (homes: { claude: string; codex: string }) => Promise<T>): Promise<T> {
  const claude = claudeHome();
  const codex = codexHome();
  const previous = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, SIMEM_HOME: process.env.SIMEM_HOME };
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.CODEX_HOME = codex;
  process.env.SIMEM_HOME = mkdtempSync(join(tmpdir(), "simem-install-home-"));
  try {
    return await fn({ claude, codex });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("user-level install writes hooks, MCP, and instructions per account home; re-runs are byte-stable; remove restores", async () => {
  await withHomes(async ({ claude, codex }) => {
    const userHook = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, theme: "dark" };
    writeFileSync(join(claude, "settings.json"), `${JSON.stringify(userHook, null, 2)}\n`);
    const claudeJson = `${JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } }, null, 2)}\n`;
    writeFileSync(join(claude, ".claude.json"), claudeJson);
    writeFileSync(join(codex, "config.toml"), 'model = "gpt-5.5"\n');
    const originalSettings = readFileSync(join(claude, "settings.json"), "utf8");

    await installUserLevel({}, "/opt/simem/bin/simem");
    const settings = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.hooks.Stop.length, 2, "the user's own Stop hook is kept");
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PreCompact", "Stop", "SessionEnd"]) {
      assert.ok(JSON.stringify(settings.hooks[event]).includes(`\\"/opt/simem/bin/simem\\" hook`), `${event} missing`);
    }
    assert.equal(settings.hooks.PreToolUse[0].matcher, "Bash|Read");
    const mcp = JSON.parse(readFileSync(join(claude, ".claude.json"), "utf8"));
    assert.equal(mcp.numStartups, 3);
    assert.deepEqual(mcp.mcpServers.simem.args, ["mcp", "--provider", "claude", "--scope", "user"]);
    assert.ok(mcp.mcpServers.other);
    assert.match(readFileSync(join(claude, "CLAUDE.md"), "utf8"), /simem:integrate:start/);
    const codexHooks = JSON.parse(readFileSync(join(codex, "hooks.json"), "utf8"));
    assert.equal(codexHooks.hooks.PreToolUse, undefined, "Codex gets no PreToolUse (rewrites would require auto-approval)");
    assert.ok(codexHooks.hooks.SessionEnd);
    assert.match(readFileSync(join(codex, "config.toml"), "utf8"), /^model = "gpt-5\.5"\n[\s\S]*\[mcp_servers\.simem\]/);
    assert.equal(userLevelCovers("claude"), true);

    const snapshot = () => [join(claude, "settings.json"), join(claude, ".claude.json"), join(codex, "hooks.json"), join(codex, "config.toml")].map((path) => readFileSync(path, "utf8"));
    const before = snapshot();
    const second = await installUserLevel({}, "/opt/simem/bin/simem");
    assert.ok(second.every((plan) => plan.files.every((file) => file.action === "unchanged")), "a re-run changes nothing");
    assert.deepEqual(snapshot(), before, "byte-stable, so Codex trust hashes stay valid");

    await installUserLevel({ remove: true }, "/opt/simem/bin/simem");
    assert.equal(readFileSync(join(claude, "settings.json"), "utf8"), originalSettings);
    assert.equal(readFileSync(join(claude, ".claude.json"), "utf8"), claudeJson);
    assert.equal(readFileSync(join(codex, "config.toml"), "utf8"), 'model = "gpt-5.5"\n');
    assert.equal(existsSync(join(codex, "hooks.json")), false);
    assert.equal(userLevelCovers("claude"), false);
  });
});

test("an account that never ran Claude Code gets no .claude.json created", async () => {
  await withHomes(async ({ claude }) => {
    const plans = await installUserLevel({}, "/opt/simem/bin/simem");
    assert.equal(existsSync(join(claude, ".claude.json")), false);
    assert.ok(plans.some((plan) => plan.notes.some((note) => note.includes("MCP tools not registered"))));
  });
});

test("the launcher pins node + CLI and falls back quietly when they move", () => {
  const dir = mkdtempSync(join(tmpdir(), "simem-launcher-"));
  const script = join(dir, "simem");
  writeFileSync(script, launcherScript(process.execPath, "/does/not/exist.js"), { mode: 0o755 });
  const missing = spawnSync(script, ["--version"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(missing.status, 0, "a broken launcher must never fail a host hook");
  assert.match(missing.stderr, /run: simem init/);
  let entry: string | undefined;
  try {
    entry = cliEntry();
  } catch {
    entry = undefined;
  }
  if (!entry || entry.endsWith(".ts")) return;
  writeFileSync(script, launcherScript(process.execPath, entry), { mode: 0o755 });
  const ok = spawnSync(script, ["--version"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^\d+\.\d+\.\d+/);
});

test("the launcher pins Homebrew's stable opt/ path, so `brew upgrade` doesn't break it", () => {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), "simem-brew-")));
  const keg = join(prefix, "Cellar", "simem", "2.0.2");
  mkdirSync(join(keg, "libexec", "dist"), { recursive: true });
  writeFileSync(join(keg, "libexec", "dist", "cli.js"), "");
  mkdirSync(join(prefix, "opt"));
  symlinkSync("../Cellar/simem/2.0.2", join(prefix, "opt", "simem"));
  const kegPath = join(keg, "libexec", "dist", "cli.js");
  assert.equal(stableHomebrewPath(kegPath), join(prefix, "opt", "simem", "libexec", "dist", "cli.js"));
  // No opt/ link, a link to another keg, or a path outside Homebrew: unchanged.
  mkdirSync(join(prefix, "Cellar", "node", "24.0.0", "bin"), { recursive: true });
  writeFileSync(join(prefix, "Cellar", "node", "24.0.0", "bin", "node"), "");
  assert.equal(stableHomebrewPath(join(prefix, "Cellar", "node", "24.0.0", "bin", "node")), join(prefix, "Cellar", "node", "24.0.0", "bin", "node"));
  mkdirSync(join(prefix, "Cellar", "simem", "2.0.1", "libexec", "dist"), { recursive: true });
  writeFileSync(join(prefix, "Cellar", "simem", "2.0.1", "libexec", "dist", "cli.js"), "");
  const oldKeg = join(prefix, "Cellar", "simem", "2.0.1", "libexec", "dist", "cli.js");
  assert.equal(stableHomebrewPath(oldKeg), oldKeg);
  assert.equal(stableHomebrewPath("/usr/local/lib/node_modules/@simem/cli/dist/cli.js"), "/usr/local/lib/node_modules/@simem/cli/dist/cli.js");
});

test("`simem init` end to end: launcher, user-level install, history import, idempotent", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "simem-init-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), `x ${repo}\n`);
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "i"], { cwd: repo });
  const claude = claudeHome();
  const env = {
    ...process.env,
    SIMEM_HOME: mkdtempSync(join(tmpdir(), "simem-init-home-")),
    SIMEM_STORAGE: "global",
    SIMEM_HOME_DISCOVERY: "env",
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: "",
  };
  writeFileSync(join(claude, ".claude.json"), "{}\n");
  const cli = join(process.cwd(), "src", "cli.ts");
  const run = () => spawnSync(process.execPath, ["--import", "tsx", cli, "init", "--no-model", "--cwd", repo], { cwd: process.cwd(), env, encoding: "utf8" });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Launcher: /);
  assert.match(first.stdout, /Installed for every agent account/);
  assert.match(first.stdout, /Restart the Claude Code and Codex apps/);
  assert.ok(existsSync(join(env.SIMEM_HOME, "bin", "simem")));
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already up to date/);
});

test("the standalone launcher execs the binary alone and falls back quietly", () => {
  const dir = mkdtempSync(join(tmpdir(), "simem-launcher-sea-"));
  const script = join(dir, "simem");
  writeFileSync(script, launcherScript("/bin/echo", ""), { mode: 0o755 });
  const ok = spawnSync(script, ["hello", "world"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(ok.stdout, "hello world\n");
  writeFileSync(script, launcherScript("/does/not/exist", ""), { mode: 0o755 });
  const missing = spawnSync(script, ["--version"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(missing.status, 0);
});
