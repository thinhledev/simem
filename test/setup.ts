// Loaded before every test file (see the npm "test" script). Isolates tests
// from the developer's real ~/.simem and agent homes:
// - SIMEM_HOME points at a throwaway directory.
// - SIMEM_STORAGE=project keeps the 1.x in-repo layout that most tests were
//   written against; global-store tests opt in explicitly.
// - SIMEM_HOME_DISCOVERY=env restricts agent-home discovery to the homes a
//   test names through CLAUDE_CONFIG_DIR / CODEX_HOME, never ~/.claude-* globs.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SIMEM_HOME = mkdtempSync(join(tmpdir(), "simem-test-home-"));
process.env.SIMEM_STORAGE ??= "project";
process.env.SIMEM_HOME_DISCOVERY = "env";
// - SIMEM_NO_BACKGROUND=1 keeps hooks from spawning detached indexers.
process.env.SIMEM_NO_BACKGROUND = "1";
