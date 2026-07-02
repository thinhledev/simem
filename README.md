# Coding Agents Orchestrator

A local-first gateway shell for Codex, Claude Code, and Cursor CLI. Phase 1 owns provider discovery, credential-aware routing, normalized run events, session references, and safe fallback. Durable SQLite memory arrives in Phase 2.

## What works

- Discovers installed and authenticated provider CLIs without spending tokens.
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

## Usage

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

Phase 1 deliberately keeps state in memory. Phase 2 will add the SQLite system of record, checkpoints, FTS5 retrieval, repo snapshots, and provider-neutral handoff packets. The current normalized event and session contracts are the seam for that work.

Provider integrations follow the official automation surfaces: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive), [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), and [Cursor headless CLI](https://docs.cursor.com/en/cli/headless).
