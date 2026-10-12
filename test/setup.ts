// Loaded before every test file (see the npm "test" script). Isolates tests
// from the developer's real ~/.mixai and agent homes:
// - MIXAI_HOME points at a throwaway directory.
// - MIXAI_STORAGE=project keeps the 1.x in-repo layout that most tests were
//   written against; global-store tests opt in explicitly.
// - MIXAI_HOME_DISCOVERY=env restricts agent-home discovery to the homes a
//   test names through CLAUDE_CONFIG_DIR / CODEX_HOME, never ~/.claude-* globs.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MIXAI_HOME = mkdtempSync(join(tmpdir(), "mixai-test-home-"));
process.env.MIXAI_STORAGE ??= "project";
process.env.MIXAI_HOME_DISCOVERY = "env";
