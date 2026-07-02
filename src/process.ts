import { spawn } from "node:child_process";

export interface CommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: Error;
}

export type LineHandler = (line: string) => void;

export interface CommandRunner {
  run(spec: CommandSpec, onStdoutLine?: LineHandler): Promise<CommandResult>;
}

function makeLineCollector(onLine: LineHandler | undefined): {
  push(chunk: string): void;
  flush(): void;
} {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line) onLine?.(line);
      }
    },
    flush() {
      if (pending) onLine?.(pending);
      pending = "";
    },
  };
}

export class NodeCommandRunner implements CommandRunner {
  async run(spec: CommandSpec, onStdoutLine?: LineHandler): Promise<CommandResult> {
    return await new Promise((resolveResult) => {
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let spawnError: Error | undefined;
      const collector = makeLineCollector(onStdoutLine);
      const child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        collector.push(text);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        spawnError = error;
      });

      const timeout = spec.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
          }, spec.timeoutMs)
        : undefined;
      timeout?.unref();

      child.on("close", (exitCode) => {
        if (timeout) clearTimeout(timeout);
        collector.flush();
        resolveResult({
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
          ...(spawnError ? { error: spawnError } : {}),
        });
      });

      if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
      else child.stdin.end();
    });
  }
}

export function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
