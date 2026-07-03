import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../process.js";
import { PROVIDER_APP_NAME, type ProviderId } from "../types.js";
import type { SwitchSurface } from "./switcher.js";

export interface LaunchReadiness {
  ready: boolean;
  message?: string;
  loginCommand?: string;
}

export async function checkLaunchReadiness(
  runner: CommandRunner,
  provider: ProviderId,
  surface: SwitchSurface = "interactive",
): Promise<LaunchReadiness> {
  if (surface === "desktop") {
    if (process.platform !== "darwin") {
      return {
        ready: false,
        message: "Desktop launching is currently supported on macOS; use --surface interactive on this platform",
      };
    }
    const appName = `${PROVIDER_APP_NAME[provider]}.app`;
    const locations = [join("/Applications", appName), join(homedir(), "Applications", appName)];
    for (const path of locations) {
      try {
        await access(path);
        return { ready: true };
      } catch {
        // Try the next standard application directory.
      }
    }
    return { ready: false, message: `${appName} is not installed in a standard Applications directory` };
  }

  if (provider === "claude") {
    if (process.env.ANTHROPIC_API_KEY) return { ready: true };
    const result = await runner.run({ command: "claude", args: ["auth", "status", "--json"], timeoutMs: 5_000 });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { ready: false, message: "Claude Code is not installed", loginCommand: "claude --help" };
    }
    try {
      const status = JSON.parse(result.stdout) as { loggedIn?: boolean };
      if (result.exitCode === 0 && status.loggedIn === true) return { ready: true };
    } catch {
      // Fall through to the actionable authentication message.
    }
    return {
      ready: false,
      message: "Claude Code is installed but not authenticated. An API key is optional; a Claude Pro/Max account can sign in directly.",
      loginCommand: "claude auth login",
    };
  }

  if (provider === "codex") {
    if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) return { ready: true };
    const result = await runner.run({ command: "codex", args: ["login", "status"], timeoutMs: 5_000 });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { ready: false, message: "Codex CLI is not installed", loginCommand: "codex --help" };
    }
    return result.exitCode === 0
      ? { ready: true }
      : { ready: false, message: "Codex is not authenticated", loginCommand: "codex login" };
  }

  if (provider === "antigravity") {
    const result = await runner.run({ command: "agy", args: ["--version"], timeoutMs: 5_000 });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { ready: false, message: "Antigravity CLI (agy) is not installed", loginCommand: "agy install" };
    }
    return result.exitCode === 0
      ? { ready: true }
      : { ready: false, message: "Antigravity CLI (agy) is not ready", loginCommand: "agy install" };
  }

  if (process.env.CURSOR_API_KEY) return { ready: true };
  const result = await runner.run({ command: "cursor-agent", args: ["ls"], timeoutMs: 5_000 });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return { ready: false, message: "Cursor CLI is not installed", loginCommand: "cursor-agent --help" };
  }
  return result.exitCode === 0
    ? { ready: true }
    : { ready: false, message: "Cursor CLI is not authenticated", loginCommand: "cursor-agent login" };
}
