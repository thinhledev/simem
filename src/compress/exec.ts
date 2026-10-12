import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { openMemoryDb, type MemoryDb } from "../memory/db.js";
import { recordSavings } from "../memory/savings.js";
import { sanitize } from "../memory/sanitize.js";
import { filterOutput } from "./filters.js";

// Below these, compressing isn't worth a footer and a stored copy.
const MIN_RAW_CHARS = 2_000;
const MIN_SAVED_RATIO = 0.2;
const OUTPUT_RETENTION_DAYS = 7;
const OUTPUT_RETENTION_ROWS = 300;

export interface ExecResult {
  exitCode: number;
  raw: string;
  text: string;
  outputId?: string;
}

function run(argv: string[], cwd: string): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    // One argument = a shell command line (pipes, globs, &&); several = argv.
    const child =
      argv.length === 1
        ? spawn(process.env.SHELL && !process.env.SHELL.endsWith("fish") ? process.env.SHELL : "/bin/sh", ["-c", argv[0]!], { cwd, env: process.env })
        : spawn(argv[0]!, argv.slice(1), { cwd, env: process.env, shell: false });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      chunks.push(Buffer.from(`${error.message}\n`));
    });
    child.on("close", (code, signal) => {
      // Killed by a signal: report 128 + signal number, as a shell would.
      const signalCode = signal ? (constants.signals as Record<string, number>)[signal] ?? 1 : 1;
      resolve({ output: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? 128 + signalCode });
    });
  });
}

function storeOutput(memory: MemoryDb, command: string, raw: string, sentChars: number, exitCode: number): string {
  const id = randomBytes(3).toString("hex");
  memory.db
    .prepare("INSERT INTO outputs (id, session_id, command, raw_gz, raw_chars, sent_chars, exit_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, process.env.SIMEM_SESSION_ID ?? null, command.slice(0, 500), gzipSync(Buffer.from(raw)), raw.length, sentChars, exitCode, new Date().toISOString());
  const cutoff = new Date(Date.now() - OUTPUT_RETENTION_DAYS * 86_400_000).toISOString();
  memory.db.prepare("DELETE FROM outputs WHERE created_at < ?").run(cutoff);
  memory.db
    .prepare("DELETE FROM outputs WHERE id NOT IN (SELECT id FROM outputs ORDER BY created_at DESC LIMIT ?)")
    .run(OUTPUT_RETENTION_ROWS);
  return id;
}

// Runs a command, prints filtered output, keeps the full output locally, and
// exits with the command's own exit code. Credentials in output are redacted
// in both copies. If the filter saves little, the raw output is printed as is.
export async function execCompressed(argv: string[], cwd: string): Promise<ExecResult> {
  const command = argv.join(" ");
  const { output, exitCode } = await run(argv, cwd);
  const raw = sanitize(output).text;
  if (raw.length < MIN_RAW_CHARS) return { exitCode, raw, text: raw };
  const { text } = filterOutput(command, raw, exitCode);
  if (raw.length - text.length < raw.length * MIN_SAVED_RATIO) return { exitCode, raw, text: raw };
  let outputId: string | undefined;
  try {
    const memory = await openMemoryDb(cwd, { quiet: true });
    if (memory) {
      try {
        outputId = storeOutput(memory, command, raw, text.length, exitCode);
        recordSavings(memory, { mechanism: "exec", charsFull: raw.length, charsSent: text.length });
      } finally {
        memory.close();
      }
    }
  } catch {
    // Without storage, still print the filtered text — but say so.
  }
  const footer = outputId
    ? `\n[simem: ${raw.length.toLocaleString("en-US")} → ${text.length.toLocaleString("en-US")} chars · full output: simem out ${outputId}]`
    : `\n[simem: output filtered from ${raw.length.toLocaleString("en-US")} chars]`;
  return { exitCode, raw, text: `${text}${footer}`, ...(outputId ? { outputId } : {}) };
}

export function readOutput(memory: MemoryDb, id: string): { command: string; text: string; exitCode: number | null; createdAt: string } | undefined {
  const row = memory.db.prepare("SELECT command, raw_gz, exit_code, created_at FROM outputs WHERE id = ?").get(id) as
    | { command: string; raw_gz: Uint8Array; exit_code: number | null; created_at: string }
    | undefined;
  if (!row) return undefined;
  return { command: row.command, text: gunzipSync(Buffer.from(row.raw_gz)).toString("utf8"), exitCode: row.exit_code, createdAt: row.created_at };
}
