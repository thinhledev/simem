import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Where this mixai is running from: the npm package (node + dist/cli.js) or
// a standalone single-executable build (one binary, no Node.js needed).

declare const __MIXAI_VERSION__: string | undefined;

let seaCached: boolean | undefined;

/** True in the single-file bundle (and in the binary built from it). */
export function isBundled(): boolean {
  return typeof __MIXAI_VERSION__ === "string";
}

export function isStandalone(): boolean {
  if (seaCached !== undefined) return seaCached;
  try {
    const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
    seaCached = Boolean(sea?.isSea?.());
  } catch {
    seaCached = false;
  }
  return seaCached;
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

// The built CLI entry (dist/cli.js), also when running from source.
export function cliEntry(): string {
  const here = moduleDir();
  const candidates = [resolve(here, "cli.js"), resolve(here, "..", "dist", "cli.js")];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("Could not find the built mixai CLI (dist/cli.js); run `npm run build` first");
  return found;
}

// argv prefix that re-runs this same mixai: [binary] when standalone, else
// [node, dist/cli.js]. Used for detached background workers.
export function selfCommand(): string[] {
  if (isStandalone()) return [process.execPath];
  // The single-file bundle run by plain node (what the binary embeds).
  if (isBundled() && process.argv[1]) return [process.execPath, process.argv[1]];
  return [process.execPath, cliEntry()];
}

// What the launcher should exec: the binary alone, or node + a script (the
// bundle or dist/cli.js). An empty `cli` means "the binary is all of mixai".
export function launcherTarget(): { node: string; cli: string } {
  if (isStandalone()) return { node: process.execPath, cli: "" };
  if (isBundled() && process.argv[1]) return { node: process.execPath, cli: process.argv[1] };
  return { node: process.execPath, cli: cliEntry() };
}

export function mixaiVersion(): string {
  if (typeof __MIXAI_VERSION__ === "string") return __MIXAI_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(resolve(moduleDir(), "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
