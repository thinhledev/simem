import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { storageMode } from "../store/home.js";
import { migrateLegacyStore, migrateToProject } from "../store/migrate.js";
import { clearProjectCache, linkProject, listProjects, projectLocalMarker, resolveProject, unlinkProject } from "../store/project.js";
import { displayPath, print, type Output } from "./common.js";

export async function runProject(sub: string | undefined, args: string[], options: Output & { cwd: string }): Promise<void> {
  if (!sub || sub === "show") {
    const ref = resolveProject(options.cwd);
    print(
      options,
      [
        `Project: ${ref.name} (${ref.id})`,
        `Root: ${displayPath(ref.root)}`,
        `Store: ${displayPath(ref.storeDir)} (${ref.mode})`,
        `Identified by: ${ref.identifiedBy === "root" ? "git root commit (shared by every clone and worktree)" : ref.identifiedBy}`,
        ...(ref.git?.remote ? [`Remote: ${ref.git.remote}`] : []),
      ].join("\n"),
      ref,
    );
    return;
  }
  if (sub === "list") {
    const projects = listProjects();
    if (options.json) return print(options, "", projects);
    if (projects.length === 0) return print(options, "No projects registered yet.");
    print(options, projects.map((project) => `${project.id}  ${project.name}\n    ${project.paths.map((path) => displayPath(path)).join("\n    ")}`).join("\n"));
    return;
  }
  if (sub === "link") {
    const target = args[0];
    if (!target) throw new Error("mixai project link <project-id> (see `mixai project list`)");
    const ref = linkProject(options.cwd, target);
    print(options, `This checkout now uses project ${ref.id}. Earlier memory under the old id stays in its store; move it with mixai memory export/import.`, ref);
    return;
  }
  if (sub === "unlink") {
    const ref = unlinkProject(options.cwd);
    print(options, `This checkout is now its own project ${ref.id}.`, ref);
    return;
  }
  throw new Error(`Unknown project subcommand: ${sub}. Use: show, list, link <id>, unlink`);
}

export async function runMigrate(to: string | undefined, options: Output & { cwd: string }): Promise<void> {
  if (to === "project") {
    const ref = resolveProject(options.cwd);
    if (ref.mode === "project") return print(options, "This project already keeps its memory in the repository.");
    const path = migrateToProject(ref);
    clearProjectCache();
    print(options, `Copied memory to ${displayPath(path, options.cwd)}; this project now uses the in-repo store.`, { path });
    return;
  }
  if (to === undefined || to === "global") {
    const ref = resolveProject(options.cwd);
    const marker = projectLocalMarker(ref.root);
    if (existsSync(marker)) {
      unlinkSync(marker);
      clearProjectCache();
    }
    if (storageMode() !== "global") throw new Error("Global storage is disabled (MIXAI_STORAGE or memory.storage is \"project\").");
    const fresh = resolveProject(options.cwd);
    const legacy = join(fresh.root, ".mixai", "memory.db");
    if (existsSync(join(fresh.storeDir, "memory.db")) && existsSync(legacy)) {
      throw new Error(
        `Both ${displayPath(legacy)} and the global store exist. Move one with \`mixai memory export\` / \`mixai memory import\` to merge them.`,
      );
    }
    const outcome = migrateLegacyStore(fresh);
    print(options, outcome === "migrated" ? `Moved memory to ${displayPath(fresh.storeDir)}.` : "Nothing to migrate.", { outcome });
    return;
  }
  throw new Error("mixai migrate --to global|project");
}
