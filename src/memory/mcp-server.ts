import { createInterface } from "node:readline";
import { readGatewayState } from "../handoff/checkpoints.js";
import { showRecord } from "./cli-commands.js";
import type { MemoryDb } from "./db.js";
import { openMemoryDb } from "./db.js";
import { search } from "./retrieval.js";
import { MEMORY_CATEGORIES, MEMORY_KINDS } from "./types.js";

export const SERVER_INFO = { name: "cag-memory", version: "0.1.0" };
export const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const METHOD_NOT_FOUND = -32_601;
const INVALID_PARAMS = -32_602;
const INTERNAL_ERROR = -32_603;

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

const TOOLS = [
  {
    name: "memory_search",
    description: "Search this project's persistent memory (durable decisions, past checkpoint summaries, and transcripts).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: MEMORY_KINDS },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "Fetch a specific memory record by checkpoint id or numeric memory item/summary id.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  {
    name: "memory_save",
    description: "Record a durable fact, decision, constraint, or preference right now, without waiting for the next checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        kind: { type: "string", enum: MEMORY_KINDS },
        category: { type: "string", enum: MEMORY_CATEGORIES },
        importance: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["text", "kind", "importance"],
    },
  },
] as const;

async function callTool(memory: MemoryDb, cwd: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "memory_search") {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query.trim()) throw new Error("query is required");
    const kind = MEMORY_KINDS.includes(args.kind as (typeof MEMORY_KINDS)[number])
      ? (args.kind as (typeof MEMORY_KINDS)[number])
      : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const hits = await search(memory, query, {
      ...(kind ? { kind } : {}),
      ...(limit ? { limit } : {}),
    });
    return toolResult(hits);
  }
  if (name === "memory_get") {
    const selector = typeof args.selector === "string" ? args.selector : "";
    if (!selector) throw new Error("selector is required");
    const record = showRecord(memory, selector);
    if (!record) throw new Error(`No memory record matched ${selector}`);
    return toolResult(record);
  }
  if (name === "memory_save") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const importance = args.importance;
    if (!text) throw new Error("text is required");
    if (!MEMORY_KINDS.includes(args.kind as (typeof MEMORY_KINDS)[number])) {
      throw new Error(`kind must be one of: ${MEMORY_KINDS.join(", ")}`);
    }
    const kind = args.kind as (typeof MEMORY_KINDS)[number];
    if (typeof importance !== "number" || !Number.isInteger(importance) || importance < 1 || importance > 10) {
      throw new Error("importance must be an integer from 1 to 10");
    }
    const category = MEMORY_CATEGORIES.includes(args.category as (typeof MEMORY_CATEGORIES)[number])
      ? (args.category as (typeof MEMORY_CATEGORIES)[number])
      : undefined;
    const state = await readGatewayState(cwd);
    const now = new Date().toISOString();
    const result = memory.db
      .prepare(
        `INSERT INTO memory_items (kind, category, text, importance, status, source_checkpoint_id, created_at, last_reinforced_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(kind, category ?? null, text, importance, state.currentCheckpointId ?? null, now, now);
    return toolResult({ id: Number(result.lastInsertRowid) });
  }
  throw new Error(`Unknown tool: ${name}`);
}

// Exported for direct unit testing without spawning a child process; the
// stdio loop below is a thin wrapper around this pure request handler.
export async function handleRequest(
  memory: MemoryDb | undefined,
  cwd: string,
  raw: string,
): Promise<JsonRpcResponse | undefined> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return errorResponse(null, PARSE_ERROR, "Parse error");
  }
  const id = request.id ?? null;
  if (typeof request.method !== "string") {
    return errorResponse(id, INVALID_REQUEST, "Invalid request: missing method");
  }
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
    };
  }
  if (request.method === "notifications/initialized" || request.method === "ping") {
    return request.id === undefined ? undefined : { jsonrpc: "2.0", id, result: {} };
  }
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }
  if (request.method === "tools/call") {
    if (!memory) return errorResponse(id, INTERNAL_ERROR, "The memory database is unavailable on this runtime");
    const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
    if (!params || typeof params.name !== "string") {
      return errorResponse(id, INVALID_PARAMS, "tools/call requires params.name");
    }
    try {
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const result = await callTool(memory, cwd, params.name, args);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      return errorResponse(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    }
  }
  return errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${request.method}`);
}

export async function runMcpServer(
  cwd: string,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<void> {
  const memory = await openMemoryDb(cwd, { quiet: true });
  const rl = createInterface({ input: io.input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let response: JsonRpcResponse | undefined;
      try {
        response = await handleRequest(memory, cwd, line);
      } catch (error) {
        response = errorResponse(null, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
      }
      if (response) io.output.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    memory?.close();
  }
}
