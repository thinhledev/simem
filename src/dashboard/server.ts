import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { collectChecks } from "../commands/doctor.js";
import type { GatewayConfig } from "../config.js";
import { contentHash } from "../memory/items.js";
import { openMemoryDb } from "../memory/db.js";
import { search } from "../memory/retrieval.js";
import { demoteGlobal, listGlobalItems, promoteToGlobal } from "../sources/native.js";
import { collectStats } from "../stats/stats.js";
import { listProjects, resolveProject } from "../store/project.js";
import { DASHBOARD_HTML } from "./page.js";

export interface DashboardHandle {
  url: string;
  server: Server;
  close(): Promise<void>;
}

const IDLE_SHUTDOWN_MS = 2 * 60 * 60_000;
const MAX_BODY = 64 * 1024;

function send(response: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = type === "application/json" ? JSON.stringify(body) : String(body);
  response.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(type === "text/html" ? { "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" } : {}),
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function projectCwd(requested: string | null, fallback: string): string {
  if (!requested) return fallback;
  const project = listProjects().find((entry) => entry.id === requested);
  if (!project?.paths[0]) throw new Error("unknown project");
  return project.paths[0];
}

async function handleApi(path: string, url: URL, request: IncomingMessage, cwd: string, config: GatewayConfig): Promise<unknown> {
  const projectDir = projectCwd(url.searchParams.get("project"), cwd);
  if (path === "/api/projects") {
    const current = resolveProject(projectDir).id;
    return { current, projects: listProjects().map((project) => ({ id: project.id, name: project.name, path: project.paths[0] ?? "" })) };
  }
  if (path === "/api/global" && request.method === "GET") return { items: listGlobalItems(100) };
  const demote = /^\/api\/global\/(\d+)\/demote$/.exec(path);
  if (demote && request.method === "POST") return { removed: demoteGlobal(Number(demote[1])) };
  if (path === "/api/checks") return { checks: await collectChecks(projectDir) };
  const memory = await openMemoryDb(projectDir, { quiet: true });
  if (!memory) throw new Error("memory unavailable on this Node.js version");
  try {
    if (path === "/api/summary") {
      const days = Number(url.searchParams.get("days") ?? "30");
      const since = Number.isFinite(days) && days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
      return { project: resolveProject(projectDir), stats: collectStats(memory, since ? { since } : {}) };
    }
    if (path === "/api/memory" && request.method === "GET") {
      const query = url.searchParams.get("q")?.trim();
      const status = url.searchParams.get("status") === "archived" ? "archived" : "active";
      if (query) {
        const hits = await search(memory, query, { limit: 50, excludeMessages: true });
        return { items: hits.filter((hit) => hit.source === "memory_item").map((hit) => ({ id: hit.id, text: hit.text, importance: hit.importance })) };
      }
      return {
        items: memory.db
          .prepare(
            "SELECT id, kind, category, text, importance, origin, created_at, last_reinforced_at FROM memory_items WHERE status = ? ORDER BY importance DESC, last_reinforced_at DESC LIMIT 300",
          )
          .all(status),
      };
    }
    const item = /^\/api\/memory\/(\d+)(?:\/(forget|restore|promote))?$/.exec(path);
    if (item) {
      const id = Number(item[1]);
      const action = item[2];
      if (request.method === "POST" && action === "forget") {
        return { changed: Number(memory.db.prepare("UPDATE memory_items SET status = 'archived' WHERE id = ? AND status = 'active'").run(id).changes) > 0 };
      }
      if (request.method === "POST" && action === "restore") {
        return { changed: Number(memory.db.prepare("UPDATE memory_items SET status = 'active' WHERE id = ? AND status = 'archived'").run(id).changes) > 0 };
      }
      if (request.method === "POST" && action === "promote") {
        const row = memory.db.prepare("SELECT text, category, importance FROM memory_items WHERE id = ?").get(id) as
          | { text: string; category: string | null; importance: number }
          | undefined;
        if (!row) throw new Error("no such item");
        return { globalId: promoteToGlobal(row.text, row.category, row.importance, resolveProject(projectDir).id) };
      }
      if (request.method === "PATCH" && !action) {
        const body = await readBody(request);
        const text = typeof body.text === "string" ? body.text.trim() : undefined;
        const importance = typeof body.importance === "number" && Number.isInteger(body.importance) && body.importance >= 1 && body.importance <= 10 ? body.importance : undefined;
        if (text !== undefined && !text) throw new Error("text must not be empty");
        if (text !== undefined) {
          memory.db.prepare("UPDATE memory_items SET text = ?, content_hash = ?, origin = 'user', embedding = NULL WHERE id = ?").run(text, contentHash(text), id);
        }
        if (importance !== undefined) memory.db.prepare("UPDATE memory_items SET importance = ? WHERE id = ?").run(importance, id);
        return { changed: text !== undefined || importance !== undefined };
      }
    }
    throw new Error("not found");
  } finally {
    memory.close();
  }
}

// Serves the dashboard on 127.0.0.1 only, behind a random token in the URL
// path; requests with any other Host header are refused (DNS rebinding).
export async function startDashboard(cwd: string, config: GatewayConfig, options: { port?: number; token?: string } = {}): Promise<DashboardHandle> {
  const token = options.token ?? randomBytes(18).toString("base64url");
  let idle: NodeJS.Timeout | undefined;
  const server = createServer((request, response) => {
    clearTimeout(idle);
    idle = setTimeout(() => server.close(), IDLE_SHUTDOWN_MS);
    idle.unref();
    void (async () => {
      try {
        const host = (request.headers.host ?? "").replace(/:\d+$/, "");
        if (host !== "127.0.0.1" && host !== "localhost") return send(response, 403, { error: "forbidden host" });
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const prefix = `/${token}`;
        if (!url.pathname.startsWith(prefix)) return send(response, 404, { error: "not found" });
        const path = url.pathname.slice(prefix.length) || "/";
        if (path === "/" && request.method === "GET") return send(response, 200, DASHBOARD_HTML, "text/html");
        if (path.startsWith("/api/")) {
          if (request.method !== "GET" && request.headers["content-type"] !== "application/json") {
            return send(response, 415, { error: "send application/json" });
          }
          return send(response, 200, await handleApi(path, url, request, cwd, config));
        }
        return send(response, 404, { error: "not found" });
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  idle = setTimeout(() => server.close(), IDLE_SHUTDOWN_MS);
  idle.unref();
  return {
    url: `http://127.0.0.1:${port}/${token}/`,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
