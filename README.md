# Coding Agents Orchestrator

A local-first bridge between Codex, Claude Code, Cursor, and Antigravity. You keep working in the native coding-agent apps; `cag` creates provider-neutral checkpoints and moves the work between them when quota, cost, or preference changes.

## What works

- Discovers installed and authenticated provider CLIs without spending tokens.
- Discovers local Codex Desktop/CLI and Claude Code conversations for the current workspace.
- Exports a token-free checkpoint containing the handoff, extracted conversation, Git status, and tracked patch.
- Switches into a new or existing target conversation and supports native session forks.
- Records checkpoint lineage so Claude → Codex → Claude round trips remain traceable.
- Prefers paid API credentials, then included/subscription credentials, then free and unknown tiers.
- Uses Codex, Claude, then Cursor as the tie-break order within a credential tier.
- Normalizes provider JSONL into one event model.
- Preserves provider-native session IDs for follow-up runs.
- Falls back on auth, quota, rate-limit, availability, timeout, and provider failures.
- Stops on permission and invalid-request failures so another backend cannot silently bypass intent.
- Defaults to read-only/plan behavior; workspace changes require `--write`.

## Setup

Requires Node.js 20 or newer.

```bash
npm install
npm run build
npm link
cag status
```

No provider credential is copied into the project. Each adapter invokes its provider's local CLI:

- Codex: `CODEX_API_KEY`, or `OPENAI_API_KEY` mapped to `CODEX_API_KEY` for only the child `codex exec` process; otherwise the saved Codex login.
- Claude: `ANTHROPIC_API_KEY`; otherwise the local Claude Code login. This project does not relay Claude consumer credentials to a third party.
- Cursor: `CURSOR_API_KEY`; otherwise the local Cursor login.

The first usable paid credential wins, even if it belongs to a later provider. When tiers tie, the default order is Codex → Claude → Cursor.

API keys are optional for native subscription use. Terminal mode has its own authentication; for example, authenticate the Claude Code CLI with a Claude Pro/Max account using:

```bash
claude auth login
```

Before launching a switched session, `cag` checks that the selected surface is ready. Desktop mode uses the desktop app's existing login and does not require `claude auth login`. Interactive terminal mode checks the CLI's separate authentication; if it is not ready, the checkpoint is still saved and `cag` prints the exact login command instead of failing silently.

## Usage

### Export vs. switch vs. fork

| Command | Creates a checkpoint | Opens the target agent | Conversation behavior |
|---|---:|---:|---|
| `cag export` | Yes | No | Saves the current work for later without starting another agent. |
| `cag switch` | Yes | Yes | Interactive mode resumes a known target conversation; Desktop opens the app so you can select or create the target session. |
| `cag fork` | Yes | Yes | Records separate branch lineage and uses the target's native fork feature in interactive mode. |

Examples:

```bash
# Save Codex work without opening another agent
cag export --from codex

# Continue Codex work in the existing Claude conversation
cag switch claude --from codex

# Continue in a separate Claude branch without changing its existing conversation
cag fork claude --from codex
```

`cag switch --new` also starts a new conversation, but `cag fork` explicitly records branch lineage and forks the provider's existing target session when the selected surface supports it. None of these commands deletes or modifies the source conversation.

### Switch between coding-agent apps

The normal workflow is one command from the project directory:

```bash
# Codex Desktop/CLI → Claude Code
# Exports the latest Codex conversation, then resumes the known Claude
# conversation for this project or starts a new one.
cag switch claude --from codex

# Claude Code → Codex when Codex quota resets
cag switch codex --from claude

# Force a new target conversation
cag switch claude --from codex --new

# Branch the work. If the target already has a session, its native fork
# command is used; otherwise a new conversation starts from the checkpoint.
cag fork claude --from codex
cag fork codex --from claude
```

On macOS, switching opens the desktop app by default:

```bash
cag switch claude --from codex
cag switch codex --from claude
```

For Claude, `cag` focuses Claude Desktop and installs an idempotent local-memory bridge:

- `CLAUDE.local.md` imports `.cag/current/HANDOFF.md`, so the latest checkpoint is loaded into context at the start of every new Claude Code session.
- `.worktreeinclude` copies that private memory plus the stable `.cag/current/` handoff, transcript, patch, status, and manifest into the isolated worktree Claude Desktop creates for a new session.
- `.gitignore` keeps `.cag/` and `CLAUDE.local.md` out of version control.

Claude Desktop does not document a URL or launcher argument that selects the Code tab. Passing a folder to macOS opens that folder in Cowork, so `cag` deliberately opens the app without a folder. Click **Code**, select the project, create a new session, and send `Continue.` Claude already has the objective, previous outcome, recent conversation, and workspace state in context, so you do not need to paste the handoff. Claude cannot respond before a user message exists; sending `Continue.` is the only remaining manual step. Existing sessions do not reload startup memory, so create a new session when moving in a fresh checkpoint.

Desktop app authentication is used directly.

Anthropic's documented fully automatic bridge into an exact Desktop session is the `/desktop` command from an authenticated Claude Code terminal session. Direct Desktop switching intentionally avoids that CLI authentication requirement, so it stops at opening the project and preparing the handoff prompt.

For Cursor, `cag switch` opens the desktop app directly on the project folder (`open -a Cursor <workspace>`), the same way `code <folder>` opens a workspace in an editor. Cursor declares itself as a document handler for the relevant file/folder types, so macOS forwards the path correctly.

```bash
cag switch cursor --from codex
```

Cursor also supports `--surface interactive`, which resumes or forks a session through the `cursor-agent` CLI and can attach the handoff prompt automatically.

Antigravity is different on both surfaces:

- **Desktop.** Its `.app` bundle declares no document types, so `open -a Antigravity <folder>` is silently ignored by macOS (verified against Antigravity 2.2.1 — the folder never appears in its `history.recentlyOpenedPathsList`). No known mechanism opens the GUI on a specific folder, so `cag switch antigravity` on the desktop surface just brings the app forward and prints the folder path plus the continuation prompt for you to paste in by hand.
- **Interactive.** Antigravity ships a real terminal agent CLI, `agy` (separate from the `antigravity`/`agy` symlinks the desktop app installs under `~/.antigravity/antigravity/bin/`, which can be dangling even on a fresh install — that broken symlink is not the CLI to use). `cag switch antigravity --surface interactive` runs `agy --continue -i "<prompt>"` to resume the CLI's own most recent conversation, or `agy --new-project -i "<prompt>"` with `--new`. `agy` has no flag to point the desktop GUI at a folder, so this only starts a terminal session; it does not open the Antigravity window. There is no local session discovery for it yet, so `--to-session` cannot target a specific `agy` conversation ID.

To use terminal clients instead, opt in explicitly. This mode can attach the handoff prompt automatically and use native resume/fork commands, but it requires separate CLI authentication:

```bash
cag switch claude --from codex --surface interactive
cag switch codex --from claude --surface interactive
cag switch cursor --from codex --surface interactive
cag switch antigravity --from claude --surface interactive
```

To prepare without opening an app:

```bash
cag switch claude --from codex --no-launch
cag export --from codex
cag sessions
```

Use `--session SOURCE_ID` or `--to-session TARGET_ID` when the automatic latest/bound-session choice is not the one you want.

### Checkpoint contents

Each export is stored under `.cag/checkpoints/<id>/`:

- `HANDOFF.md`: latest objective, latest outcome, recent context, and workspace state.
- `TRANSCRIPT.md`: full extracted user/assistant conversation, excluding injected system instructions and raw tool noise.
- `WORKSPACE.patch`: staged and unstaged tracked Git changes, including binary patches.
- `STATUS.txt` and `manifest.json`: untracked-file inventory, source/target sessions, and parent checkpoint.
- `.cag/CURRENT.md`: stable pointer content for the next agent.

Checkpoint creation does not call a model, so it still works after provider quota is exhausted. The project remains the live source of truth, including untracked files; the checkpoint is a handoff bundle, not a duplicate repository. `.cag/` is gitignored because transcripts may contain sensitive project context.

### Route a one-off task

```bash
# Check readiness and see which credential tier will be used
cag status

# Let the router choose; read-only by default
cag run "Explain the architecture and identify the riskiest module"

# Allow the selected agent to edit the workspace
cag run --write "Add input validation and tests"

# Pin a provider or resume one of its native sessions
cag run --provider claude "Review the current diff"
cag run --provider codex --session SESSION_ID "Continue the task"

# Stream normalized events for another program
cag run --json "Summarize the repository"
```

Run `npm run dev -- status` before linking the package locally.

## Configuration

Copy `gateway.config.example.json` to `gateway.config.json`. The local file is gitignored because commands and model choices may be machine-specific.

Set `providers.<name>.credentialTier` when a native login's plan cannot be detected. Valid tiers are `paid`, `included`, `free`, and `unknown`.

Cursor defaults to the documented `cursor-agent` binary. If an installation exposes the newer `agent` alias, set:

```json
{
  "providers": {
    "cursor": { "enabled": true, "command": "agent" }
  }
}
```

## Phase boundary

Phase 1 now includes file-backed checkpoints and lineage. Phase 2 can move the manifest/state index into SQLite, add FTS5 retrieval, and generate richer summaries, while keeping this handoff format stable.

Provider integrations follow the official automation surfaces: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive), [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), and [Cursor headless CLI](https://docs.cursor.com/en/cli/headless). Antigravity's `agy` CLI (`agy --print`/`agy --prompt-interactive`) is not yet wired into `cag run`'s adapter/routing system and cannot be used as a `--from` source, since there is no local session discovery for it; it is currently reachable only through `cag switch`/`fork --surface interactive`.
