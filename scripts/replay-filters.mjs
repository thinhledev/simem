// Replay the real shell output from a project's Claude Code and Codex
// transcripts through simem's output filter, and print how much smaller it gets.
// Read-only. Run `npm run build` first.
//
//   node scripts/replay-filters.mjs [project-dir] [claude-transcripts-dir] [codex-sessions-dir]
//
// Defaults: the current directory, ~/.claude/projects/<that dir with "/" as "-">,
// and ~/.codex/sessions (only sessions whose working directory is the project).
// Sizes are converted to tokens at ~3.6 characters per token, as `simem stats` does.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(process.argv[2] ?? process.cwd());
const claudeDir = process.argv[3] ?? join(homedir(), ".claude", "projects", repo.replaceAll("/", "-"));
const codexDir = process.argv[4] ?? join(homedir(), ".codex", "sessions");
const simemRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { filterOutput, classifyCommand, isNoisyCommand } = await import(join(simemRoot, "dist/compress/filters.js"));
const noisy = { calls: 0, before: 0, after: 0 };

const totals = { calls: 0, before: 0, after: 0 };
const byKind = new Map();
const add = (command, output, isError) => {
  if (typeof output !== "string" || !command) return;
  const result = filterOutput(command, output, isError ? 1 : 0);
  const after = result.text;
  const kind = classifyCommand(command);
  totals.calls += 1;
  totals.before += output.length;
  totals.after += after.length;
  const k = byKind.get(kind) ?? { calls: 0, before: 0, after: 0 };
  k.calls += 1; k.before += output.length; k.after += after.length;
  byKind.set(kind, k);
  if (isNoisyCommand(command)) { noisy.calls += 1; noisy.before += output.length; noisy.after += after.length; }
};

const textOf = (content) =>
  typeof content === "string" ? content
  : Array.isArray(content) ? content.map((c) => (typeof c === "string" ? c : c.text ?? "")).join("\n")
  : "";

// Claude Code: Bash tool_use -> tool_result
for (const file of (existsSync(claudeDir) ? readdirSync(claudeDir) : []).filter((f) => f.endsWith(".jsonl"))) {
  const pending = new Map();
  for (const line of readFileSync(join(claudeDir, file), "utf8").split("\n")) {
    if (!line) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "tool_use" && part.name === "Bash") pending.set(part.id, part.input?.command);
      if (part.type === "tool_result" && pending.has(part.tool_use_id)) {
        add(pending.get(part.tool_use_id), textOf(part.content), part.is_error);
        pending.delete(part.tool_use_id);
      }
    }
  }
}

// Codex: function_call (shell/exec) -> function_call_output, sessions whose cwd is this repo
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : name.endsWith(".jsonl") ? [path] : [];
});
if (codexDir && existsSync(codexDir)) {
  for (const file of walk(codexDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    let inRepo = false;
    const pending = new Map();
    for (const line of lines) {
      if (!line) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const p = row.payload ?? {};
      if (row.type === "session_meta" || row.type === "turn_context") {
        if (typeof p.cwd === "string") inRepo = p.cwd.startsWith(repo);
      }
      if (!inRepo || row.type !== "response_item") continue;
      if (p.type === "function_call" && /shell|exec/.test(p.name ?? "")) {
        let args = {}; try { args = JSON.parse(p.arguments ?? "{}"); } catch {}
        const cmd = Array.isArray(args.command) ? args.command.join(" ") : (args.cmd ?? args.command);
        pending.set(p.call_id, cmd);
      }
      if (p.type === "function_call_output" && pending.has(p.call_id)) {
        let out = p.output;
        if (typeof out === "string") { try { const j = JSON.parse(out); out = j.output ?? out; } catch {} }
        else if (out && typeof out === "object") out = out.content ?? out.output ?? JSON.stringify(out);
        add(pending.get(p.call_id), textOf(out), false);
        pending.delete(p.call_id);
      }
    }
  }
}

const pct = (b, a) => (b ? ((1 - a / b) * 100).toFixed(1) : "0.0");
const tok = (chars) => Math.round(chars / 3.6);
console.log(`calls ${totals.calls}  before ~${tok(totals.before)} tok  after ~${tok(totals.after)} tok  saved ${pct(totals.before, totals.after)}%`);
console.log(`  automatic in Claude Code (test/build/install commands): ${noisy.calls} calls  ~${tok(noisy.before)} -> ~${tok(noisy.after)} tok  ${pct(noisy.before, noisy.after)}%`);
for (const [kind, k] of [...byKind].sort((a, b) => b[1].before - a[1].before)) {
  console.log(`  ${String(kind).padEnd(10)} ${String(k.calls).padStart(5)} calls  ~${tok(k.before)} -> ~${tok(k.after)} tok  ${pct(k.before, k.after)}%`);
}
