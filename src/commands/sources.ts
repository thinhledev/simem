import type { GatewayConfig } from "../config.js";
import { discoverHomes, type SourceAgent } from "../sources/homes.js";
import { ingestTranscript, listTranscripts, syncTranscripts } from "../sources/ingest.js";
import { importNativeMemory } from "../sources/native.js";
import { listProjects, resolveProject } from "../store/project.js";
import { displayPath, parseSince, print, type Output } from "./common.js";

export interface SyncCommandOptions extends Output {
  cwd: string;
  since?: string;
  all: boolean;
  path?: string;
  agent?: SourceAgent;
  config: GatewayConfig;
}

// `mixai sync`: zero-token backfill of every agent session on this machine,
// across all account homes, into each session's project store; then imports
// the agents' own memories. Default scope is the current project.
export async function runSync(options: SyncCommandOptions): Promise<void> {
  if (options.path) {
    const agent = options.agent ?? "claude";
    const result = await ingestTranscript({ agent, path: options.path }, { memoryConfig: options.config.memory });
    print(options, `${result.status}: ${displayPath(options.path)} (${result.messages} message(s))`, result);
    return;
  }
  const since = parseSince(options.since);
  const summary = await syncTranscripts({
    ...(since ? { since } : {}),
    ...(options.all ? {} : { cwd: options.cwd }),
    memoryConfig: options.config.memory,
  });
  const roots = options.all ? listProjects().map((project) => project.paths[0]).filter((path): path is string => Boolean(path)) : [options.cwd];
  const native = { autoMemoryItems: 0, globalItems: 0, appSummaries: 0, codexSummaries: 0 };
  for (const root of roots) {
    const result = await importNativeMemory(root);
    native.autoMemoryItems += result.autoMemoryItems;
    native.globalItems += result.globalItems;
    native.appSummaries += result.appSummaries;
    native.codexSummaries += result.codexSummaries;
  }
  const scope = options.all ? "all projects" : resolveProject(options.cwd).name;
  print(
    options,
    `Synced ${scope}: ${summary.ingested} session file(s) ingested, ${summary.unchanged} unchanged, ${summary.messages} new message(s).\n` +
      `Imported from the agents' own memory: ${native.autoMemoryItems} item(s), ${native.globalItems} user-wide preference(s), ` +
      `${native.appSummaries + native.codexSummaries} session summar${native.appSummaries + native.codexSummaries === 1 ? "y" : "ies"}. No provider tokens used.`,
    { ...summary, native },
  );
}

export async function runSources(options: Output): Promise<void> {
  const homes = discoverHomes();
  const rows = await Promise.all(
    homes.map(async (home) => ({ ...home, transcripts: (await listTranscripts([home])).length })),
  );
  if (options.json) {
    print(options, "", rows);
    return;
  }
  if (rows.length === 0) {
    print(options, "No agent homes found (looked for ~/.claude*, ~/.codex*, ~/.cursor).");
    return;
  }
  const lines = rows.map((row) => `  ${row.label.padEnd(36)} ${String(row.transcripts).padStart(5)} transcript(s)`);
  print(options, `Agent homes on this machine (every account is read; memory is shared across them):\n${lines.join("\n")}`);
}

