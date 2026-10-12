import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { startDashboard } from "../src/dashboard/server.js";
import { loadSqlite, openMemoryDb } from "../src/memory/db.js";
import { listedTools, TOOL_GROUPS } from "../src/memory/mcp-server.js";
import { recordSavings } from "../src/memory/savings.js";
import { collectStats, formatStats } from "../src/stats/stats.js";

const sqlite = await loadSqlite();
const withSqlite = { skip: sqlite ? false : "node:sqlite unavailable on this Node runtime" };

function call(url: string, options: { method?: string; host?: string; body?: unknown } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method ?? "GET", headers: { host: options.host ?? target.host, ...(payload ? { "content-type": "application/json" } : {}) } },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function seededWorkspace(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "simem-dash-"));
  const memory = await openMemoryDb(dir, { quiet: true });
  assert.ok(memory);
  memory.db.prepare("INSERT INTO checkpoints (id, created_at, workspace, source_provider, source_session_id, lineage_mode, directory, manifest_json) VALUES ('session:claude:s1', '2026-10-12T00:00:00Z', ?, 'claude', 's1', 'session', '', '{}')").run(dir);
  memory.db.prepare("INSERT INTO sessions (id, agent, external_id, surface, cwd, started_at, last_activity_at, message_count) VALUES ('session:claude:s1', 'claude', 's1', 'app', ?, '2026-10-12T00:00:00Z', '2026-10-12T00:10:00Z', 4)").run(dir);
  for (let i = 0; i < 4; i += 1) {
    memory.db.prepare("INSERT INTO turn_usage (session_id, usage_key, ts, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens) VALUES ('session:claude:s1', ?, '2026-10-12T00:00:00Z', 100, 10000, 500, 50)").run(`m${i}`);
  }
  memory.db.prepare("INSERT INTO events (session_id, ts, type, tool, bytes) VALUES ('session:claude:s1', '2026-10-12T00:00:00Z', 'command', 'Bash', 36000)").run();
  memory.db.prepare("INSERT INTO memory_items (kind, category, text, importance, status, created_at, last_reinforced_at) VALUES ('semantic', 'decision', 'Use pnpm for installs.', 8, 'active', 't', 't')").run();
  recordSavings(memory, { mechanism: "exec", charsFull: 36000, charsSent: 3600 });
  recordSavings(memory, { mechanism: "code-search", charsFull: 7200, charsSent: 720 });
  memory.close();
  return dir;
}

test("stats: measured usage, x-ray, savings split into measured vs estimate", withSqlite, async () => {
  const dir = await seededWorkspace();
  const memory = await openMemoryDb(dir, { quiet: true });
  assert.ok(memory);
  try {
    const stats = collectStats(memory);
    assert.deepEqual({ ...stats.usageTotal }, { sessions: 1, turns: 4, input: 400, cacheRead: 40000, cacheWrite: 2000, output: 200 });
    assert.equal(stats.xray[0]?.type, "command");
    assert.equal(stats.xray[0]?.tokens, 10000);
    assert.equal(stats.savings.find((row) => row.mechanism === "exec")?.measured, true);
    assert.equal(stats.savings.find((row) => row.mechanism === "code-search")?.measured, false);
    assert.equal(stats.savedTokens, 9000 + 1800);
    const text = formatStats(stats, "demo");
    assert.match(text, /Provider usage \(measured/);
    assert.match(text, /code_search instead of reading files \(estimate\)/);
    assert.match(text, /\(estimate: × 2 typical later turns\)/);
  } finally {
    memory.close();
  }
});

test("every MCP tool belongs to a group, so toolGroups can never hide one by accident", () => {
  const names = (listedTools({ runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false }) }, memoryConfig: DEFAULT_CONFIG.memory }) as Array<{ name: string }>).map((tool) => tool.name);
  for (const name of names) assert.ok(TOOL_GROUPS[name], `${name} has no tool group`);
});

test("dashboard: token and host are enforced; memory can be searched, edited, forgotten, and restored", withSqlite, async () => {
  const dir = await seededWorkspace();
  const handle = await startDashboard(dir, DEFAULT_CONFIG, { token: "t0k3n" });
  try {
    const base = handle.url.replace(/\/$/, "");
    const root = base.replace("/t0k3n", "");
    assert.equal((await call(`${root}/api/summary`)).status, 404, "no token, no data");
    assert.equal((await call(`${base}/api/summary`, { host: "evil.example" })).status, 403, "DNS rebinding blocked");
    const page = await call(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>simem memory<\/title>/);
    const summary = JSON.parse((await call(`${base}/api/summary?days=0`)).body);
    assert.equal(summary.stats.usageTotal.input, 400);
    const items = JSON.parse((await call(`${base}/api/memory`)).body).items as Array<{ id: number; text: string }>;
    assert.equal(items[0]?.text, "Use pnpm for installs.");
    const id = items[0]!.id;
    assert.equal((await call(`${base}/api/memory/${id}`, { method: "PATCH", body: { text: "Use pnpm for every install." } })).status, 200);
    assert.equal((await call(`${base}/api/memory/${id}/forget`, { method: "POST", body: {} })).status, 200);
    assert.equal(JSON.parse((await call(`${base}/api/memory`)).body).items.length, 0);
    assert.equal(JSON.parse((await call(`${base}/api/memory?status=archived`)).body).items[0].text, "Use pnpm for every install.");
    assert.equal((await call(`${base}/api/memory/${id}/forget`, { method: "POST" })).status, 415, "writes must be JSON (blocks cross-site form posts)");
    await call(`${base}/api/memory/${id}/restore`, { method: "POST", body: {} });
    assert.equal(JSON.parse((await call(`${base}/api/memory`)).body).items.length, 1);
  } finally {
    await handle.close();
  }
});
