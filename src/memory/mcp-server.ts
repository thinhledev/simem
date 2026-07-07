import { createInterface } from "node:readline";
import { DEFAULT_CONFIG, type MemoryConfig } from "../config.js";
import { buildBrief } from "../handoff/brief.js";
import { readGatewayState } from "../handoff/checkpoints.js";
import { spawnDetachedConsolidation, type ConsolidationSpawner } from "../handoff/hooks.js";
import { checkLaunchReadiness } from "../handoff/preflight.js";
import { displayCommand, launchSwitch, prepareSwitch, type SwitchPlan } from "../handoff/switcher.js";
import { NodeCommandRunner, type CommandRunner } from "../process.js";
import { PROVIDER_IDS, type ProviderId } from "../types.js";
import { showRecord } from "./cli-commands.js";
import type { MemoryDb } from "./db.js";
import { openMemoryDb } from "./db.js";
import { toPreview } from "./preview.js";
import { search } from "./retrieval.js";
import { recordSavings } from "./savings.js";
import { MEMORY_CATEGORIES, MEMORY_KINDS, type MemoryCategory } from "./types.js";

// Envelope-level cap on serialized preview payload size — belt-and-suspenders
// alongside per-hit preview truncation, in case a high `limit` still adds up.
const MAX_PREVIEW_RESPONSE_CHARS = 8_000;

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
    description:
      "Search this project's persistent memory (durable decisions, past checkpoint summaries, and transcripts). " +
      "Returns compact previews by default — pass full: true for complete text, or drill into one hit with memory_get.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: MEMORY_KINDS },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        category: { type: "string", enum: MEMORY_CATEGORIES },
        minImportance: { type: "integer", minimum: 1, maximum: 10 },
        since: { type: "string", description: "ISO timestamp lower bound" },
        until: { type: "string", description: "ISO timestamp upper bound" },
        full: { type: "boolean", description: "Return complete hit text instead of previews (default: false)" },
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
    name: "context_brief",
    description:
      "Rebuild working context after a compaction or reset: the latest objective/outcome, live git state, " +
      "and the most relevant project memory — deterministic, no LLM call. Use this instead of re-exploring the repository.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Optional retrieval focus; defaults to the latest checkpoint's objective" },
        maxChars: { type: "integer", minimum: 500, maximum: 32_000 },
      },
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
  {
    name: "list_handoff_targets",
    description:
      "Check which other coding agents (Codex, Claude Code, Cursor, Antigravity) are installed and ready to " +
      "take over this workspace right now — useful when you or the user are rate-limited, out of usage, or " +
      "the user asks to switch agents. Excludes the agent currently running this tool. 'Ready' means " +
      "installed and authenticated, not remaining usage/quota — no agent's CLI exposes that.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "switch_to_provider",
    description:
      "Hand off the current task to another coding agent: writes a checkpoint of this session's work " +
      "(objective, outcome, live git state) and, on macOS, opens the target agent's desktop app with a " +
      "continuation prompt ready. On other platforms (or if the target has no desktop app), returns a " +
      "ready-to-run terminal command instead, since launching an interactive CLI process from inside this " +
      "MCP server cannot attach to a real terminal. Only call this after the user has confirmed they want to " +
      "switch — e.g. after list_handoff_targets showed a ready option and the user agreed.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: [...PROVIDER_IDS] },
        surface: { type: "string", enum: ["desktop", "interactive"], description: "Defaults to desktop on macOS, interactive elsewhere" },
        fork: { type: "boolean", description: "Keep this session active too, instead of an exclusive switch" },
      },
      required: ["target"],
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
    const category = MEMORY_CATEGORIES.includes(args.category as MemoryCategory)
      ? (args.category as MemoryCategory)
      : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const minImportance = typeof args.minImportance === "number" ? args.minImportance : undefined;
    const since = typeof args.since === "string" ? args.since : undefined;
    const until = typeof args.until === "string" ? args.until : undefined;
    const full = args.full === true;
    const hits = await search(memory, query, {
      ...(kind ? { kind } : {}),
      ...(category ? { category } : {}),
      ...(limit ? { limit } : {}),
      ...(minImportance !== undefined ? { minImportance } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
    });
    if (full) return toolResult(hits);
    const previews = hits.map((hit) => toPreview(hit));
    let payload = previews;
    let truncated = previews.some((preview) => preview.truncated);
    while (payload.length > 0 && JSON.stringify(payload).length > MAX_PREVIEW_RESPONSE_CHARS) {
      payload = payload.slice(0, -1);
      truncated = true;
    }
    recordSavings(memory, {
      mechanism: "disclosure",
      charsFull: hits.reduce((sum, hit) => sum + hit.text.length, 0),
      charsSent: payload.reduce((sum, preview) => sum + preview.preview.length, 0),
    });
    return toolResult({ hits: payload, truncated, hint: "Use memory_get with a hit's id for full text." });
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

// Dependencies for tools that reach outside the memory database (git state,
// config-driven budgets, cross-agent handoff). Defaults are real
// implementations; tests inject fakes. `selfProvider` is set from `cag mcp
// --provider X` at registration time (see cag integrate) so handoff tools
// know which agent they're serving and can exclude it from targets.
export interface McpDeps {
  runner: CommandRunner;
  memoryConfig: MemoryConfig;
  selfProvider?: ProviderId;
  configPath?: string;
  spawnConsolidation?: ConsolidationSpawner;
  launch?: (plan: SwitchPlan) => Promise<number | null>;
  // checkDesktopApp/checkLaunchReadiness reach the real filesystem (installed
  // apps under /Applications) regardless of the injected runner — override
  // this in tests so handoff-tool behavior doesn't depend on what's actually
  // installed on the machine running the suite.
  checkReadiness?: typeof checkLaunchReadiness;
}

function defaultDeps(): McpDeps {
  return { runner: new NodeCommandRunner(), memoryConfig: DEFAULT_CONFIG.memory };
}

// Exported for direct unit testing without spawning a child process; the
// stdio loop below is a thin wrapper around this pure request handler.
export async function handleRequest(
  memory: MemoryDb | undefined,
  cwd: string,
  raw: string,
  deps: McpDeps = defaultDeps(),
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
    const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
    if (!params || typeof params.name !== "string") {
      return errorResponse(id, INVALID_PARAMS, "tools/call requires params.name");
    }
    const args = (params.arguments as Record<string, unknown>) ?? {};
    // context_brief opens (and can live without) its own memory connection,
    // so it stays available even when this server's DB handle is absent
    // (Node < 22.5) — the brief degrades to checkpoint + git state.
    if (params.name === "context_brief") {
      try {
        const objective = typeof args.objective === "string" ? args.objective : undefined;
        const maxChars = typeof args.maxChars === "number" && Number.isInteger(args.maxChars) ? args.maxChars : undefined;
        const brief = await buildBrief(deps.runner, {
          cwd,
          memoryConfig: deps.memoryConfig,
          ...(objective !== undefined ? { objective } : {}),
          ...(maxChars !== undefined ? { maxChars } : {}),
        });
        return { jsonrpc: "2.0", id, result: toolResult(brief) };
      } catch (error) {
        return errorResponse(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
      }
    }
    if (params.name === "list_handoff_targets") {
      try {
        const checkReadiness = deps.checkReadiness ?? checkLaunchReadiness;
        const self = deps.selfProvider;
        const targets = await Promise.all(
          PROVIDER_IDS.filter((id) => id !== self).map(async (target) => {
            const [desktop, interactive] = await Promise.all([
              checkReadiness(deps.runner, target, "desktop"),
              checkReadiness(deps.runner, target, "interactive"),
            ]);
            const ready = desktop.ready || interactive.ready;
            const surface = desktop.ready ? "desktop" : interactive.ready ? "interactive" : undefined;
            const detail = ready ? undefined : (interactive.message ?? desktop.message);
            return { provider: target, ready, ...(surface ? { surface } : {}), ...(detail ? { detail } : {}) };
          }),
        );
        return { jsonrpc: "2.0", id, result: toolResult({ self: self ?? null, targets }) };
      } catch (error) {
        return errorResponse(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
      }
    }
    if (params.name === "switch_to_provider") {
      try {
        const target = args.target;
        if (typeof target !== "string" || !PROVIDER_IDS.includes(target as ProviderId)) {
          throw new Error(`target must be one of: ${PROVIDER_IDS.join(", ")}`);
        }
        if (deps.selfProvider && target === deps.selfProvider) {
          throw new Error(`target must differ from the calling agent (${deps.selfProvider})`);
        }
        const requestedSurface = args.surface;
        if (requestedSurface !== undefined && requestedSurface !== "desktop" && requestedSurface !== "interactive") {
          throw new Error('surface must be "desktop" or "interactive"');
        }
        const surface = (requestedSurface as "desktop" | "interactive" | undefined)
          ?? (process.platform === "darwin" ? "desktop" : "interactive");
        const checkReadiness = deps.checkReadiness ?? checkLaunchReadiness;
        const readiness = await checkReadiness(deps.runner, target as ProviderId, surface);
        if (!readiness.ready) {
          return {
            jsonrpc: "2.0",
            id,
            result: toolResult({
              ok: false,
              target,
              surface,
              reason: "not_ready",
              message: readiness.message,
              ...(readiness.loginCommand ? { loginCommand: readiness.loginCommand } : {}),
            }),
          };
        }
        const plan = await prepareSwitch(deps.runner, {
          cwd,
          target: target as ProviderId,
          ...(deps.selfProvider ? { source: deps.selfProvider } : {}),
          fork: args.fork === true,
          surface,
          memoryConfig: deps.memoryConfig,
        });
        if (deps.memoryConfig.enabled) {
          const spawnConsolidation = deps.spawnConsolidation ?? spawnDetachedConsolidation;
          spawnConsolidation(cwd, plan.checkpoint.manifest.id, deps.configPath);
        }
        // Desktop surface just opens a GUI app (safe, detached, stdio ignored).
        // Interactive would spawn a CLI process attached via stdio: "inherit" —
        // but this MCP server has no real terminal (its stdio is the JSON-RPC
        // pipe to the host agent), so an interactive launch here can't give
        // the user a usable session. Return the ready command instead.
        if (surface === "desktop") {
          const launch = deps.launch ?? launchSwitch;
          await launch(plan);
          return {
            jsonrpc: "2.0",
            id,
            result: toolResult({
              ok: true,
              target,
              surface,
              launched: true,
              checkpointId: plan.checkpoint.manifest.id,
              message: `Opened ${target}. The checkpoint and continuation prompt are ready.`,
            }),
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: toolResult({
            ok: true,
            target,
            surface,
            launched: false,
            checkpointId: plan.checkpoint.manifest.id,
            manualCommand: displayCommand(plan),
            message: `Checkpoint ready. Run this in your terminal to continue in ${target}: ${displayCommand(plan)}`,
          }),
        };
      } catch (error) {
        return errorResponse(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
      }
    }
    if (!memory) return errorResponse(id, INTERNAL_ERROR, "The memory database is unavailable on this runtime");
    try {
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
  deps: McpDeps = defaultDeps(),
): Promise<void> {
  const memory = await openMemoryDb(cwd, { quiet: true });
  const rl = createInterface({ input: io.input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let response: JsonRpcResponse | undefined;
      try {
        response = await handleRequest(memory, cwd, line, deps);
      } catch (error) {
        response = errorResponse(null, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
      }
      if (response) io.output.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    memory?.close();
  }
}
