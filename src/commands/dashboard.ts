import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { GatewayConfig } from "../config.js";
import { cliEntry } from "../install/launcher.js";
import { startDashboard } from "../dashboard/server.js";
import { print, type Output } from "./common.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is printed either way.
  }
}

async function waitUntilUp(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// `mixai dashboard`: local, private web UI for memory and savings.
// --detach runs it in the background (what an agent should use) and prints
// the URL; it stops by itself after two idle hours.
export async function runDashboard(options: Output & { cwd: string; config: GatewayConfig; port?: number; open: boolean; detach: boolean }): Promise<void> {
  if (options.detach) {
    const port = options.port ?? (await freePort());
    const token = randomBytes(18).toString("base64url");
    const entry = cliEntry();
    spawn(process.execPath, [entry, "dashboard", "--port", String(port), "--cwd", options.cwd], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MIXAI_DASHBOARD_TOKEN: token },
    }).unref();
    const url = `http://127.0.0.1:${port}/${token}/`;
    const up = await waitUntilUp(url);
    if (options.open && up) openBrowser(url);
    print(options, up ? `mixai dashboard: ${url}\n(private to this machine; stops by itself after 2 idle hours)` : "The dashboard did not start; run `mixai dashboard` in a terminal to see why.", { url, up });
    if (!up) process.exitCode = 1;
    return;
  }
  const handle = await startDashboard(options.cwd, options.config, {
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(process.env.MIXAI_DASHBOARD_TOKEN ? { token: process.env.MIXAI_DASHBOARD_TOKEN } : {}),
  });
  if (options.open) openBrowser(handle.url);
  print(options, `mixai dashboard: ${handle.url}\nPress Ctrl+C to stop.`, { url: handle.url });
  await new Promise<void>((resolve) => handle.server.on("close", () => resolve()));
}
