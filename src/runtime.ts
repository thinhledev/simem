import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Where this simem is running from: the npm package (node + dist/cli.js) or
// a standalone single-executable build (one binary, no Node.js needed).

declare const __SIMEM_VERSION__: string | undefined;

let seaCached: boolean | undefined;

/** True in the single-file bundle (and in the binary built from it). */
export function isBundled(): boolean {
  return typeof __SIMEM_VERSION__ === "string";
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
  if (!found) throw new Error("Could not find the built simem CLI (dist/cli.js); run `npm run build` first");
  return found;
}

// argv prefix that re-runs this same simem: [binary] when standalone, else
// [node, dist/cli.js]. Used for detached background workers.
export function selfCommand(): string[] {
  if (isStandalone()) return [process.execPath];
  // The single-file bundle run by plain node (what the binary embeds).
  if (isBundled() && process.argv[1]) return [process.execPath, process.argv[1]];
  return [process.execPath, cliEntry()];
}

// Homebrew runs everything from versioned keg paths (<prefix>/Cellar/<name>/<version>/...)
// and deletes old kegs after `brew upgrade`. Its <prefix>/opt/<name> symlink always
// points at the current keg, so pin that instead when it leads to the same file.
export function stableHomebrewPath(path: string): string {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/.exec(path);
  if (!match) return path;
  const [, prefix, name, rest] = match;
  const stable = `${prefix}/opt/${name}/${rest}`;
  try {
    return realpathSync(stable) === realpathSync(path) ? stable : path;
  } catch {
    return path;
  }
}

// What the launcher should exec: the binary alone, or node + a script (the
// bundle or dist/cli.js). An empty `cli` means "the binary is all of simem".
export function launcherTarget(): { node: string; cli: string } {
  const node = stableHomebrewPath(process.execPath);
  if (isStandalone()) return { node, cli: "" };
  if (isBundled() && process.argv[1]) return { node, cli: stableHomebrewPath(process.argv[1]) };
  return { node, cli: stableHomebrewPath(cliEntry()) };
}

export function simemVersion(): string {
  if (typeof __SIMEM_VERSION__ === "string") return __SIMEM_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(resolve(moduleDir(), "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
