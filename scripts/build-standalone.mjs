#!/usr/bin/env node
// Builds a standalone `mixai` executable (no Node.js needed on the target
// machine) with Node's single-executable-application support:
//   1. esbuild bundles src/cli.ts into one CommonJS file
//   2. node --experimental-sea-config turns it into a blob
//   3. postject injects the blob into a copy of this Node binary
// Output: build/standalone/mixai-<platform>-<arch>. Build on each target
// platform (see .github/workflows/standalone.yml); a binary only runs on the
// OS and CPU it was built on.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "build", "standalone");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const bundle = join(out, "mixai.cjs");
const blob = join(out, "mixai.blob");
const binary = join(out, `mixai-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);
const bundleOnly = process.argv.includes("--bundle-only");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
await esbuild.build({
  entryPoints: [join(root, "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: bundle,
  define: { __MIXAI_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "warning",
  // runtime.ts only reads import.meta when not bundled; in the bundle it is unused.
  logOverride: { "empty-import-meta": "silent" },
});
console.log(`bundle: ${bundle}`);
if (bundleOnly) process.exit(0);

let postject;
try {
  postject = require.resolve("postject/dist/cli.js");
} catch {
  console.error("postject is not installed. Run `npm install --no-save postject` and try again.");
  process.exit(1);
}

writeFileSync(
  join(out, "sea-config.json"),
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }),
);
execFileSync(process.execPath, ["--experimental-sea-config", join(out, "sea-config.json")], { stdio: "inherit" });
copyFileSync(process.execPath, binary);
chmodSync(binary, 0o755);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", binary], { stdio: "inherit" });
execFileSync(
  process.execPath,
  [
    postject,
    binary,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ],
  { stdio: "inherit" },
);
// Ad-hoc signature so macOS runs it locally; release builds can sign properly.
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", binary], { stdio: "inherit" });
const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
if (version !== pkg.version) throw new Error(`built binary reports ${version}, expected ${pkg.version}`);
console.log(`binary: ${binary} (mixai ${version})`);
