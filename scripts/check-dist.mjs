#!/usr/bin/env node
// Fails if dist/ holds compiled files whose source no longer exists, so a
// publish never ships stale modules. (prepublishOnly can't simply `rm -rf
// dist`: npm 11 then drops the `simem` bin from the published manifest.)
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
const stale = walk(join(root, "dist"))
  .filter((path) => path.endsWith(".js"))
  .map((path) => relative(join(root, "dist"), path).replace(/\.js$/, ".ts"))
  .filter((source) => {
    try {
      statSync(join(root, "src", source));
      return false;
    } catch {
      return true;
    }
  });
if (stale.length > 0) {
  console.error(`dist/ has files with no source (run \`npm run build:clean\`): ${stale.join(", ")}`);
  process.exit(1);
}
