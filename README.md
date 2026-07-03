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
- Indexes every checkpoint into a local, queryable memory that never loses important context but never grows unbounded either (see [Persistent memory](#persistent-memory)).

## Setup

Requires Node.js 22.5 or newer for the core handoff/routing features. Persistent memory (`cag memory ...`, `cag mcp`) additionally requires **Node.js 22.5+** for the built-in `node:sqlite` module; on older Node, those commands report the database as unavailable and everything else keeps working unchanged.

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

`cag status`'s "ready" column reflects whether the provider's **desktop app is installed** — not whether a CLI is separately authenticated or an API key is set, since `cag switch` is the primary way you'll use all four providers. `version` is the desktop app's own bundle version (not the CLI's). `detail` reports all three readiness dimensions so a "ready: yes" row that still can't run headlessly is self-explanatory, e.g. `desktop app ready, CLI not ready, credentials not ready`. This means `cag status` can say a provider is "ready" while `cag run`/`cag switch --surface interactive` still fail, because those genuinely execute the standalone CLI, which needs its own separate login regardless of the desktop app's state. `credential` stays CLI-derived.

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

### Manual steps by provider

| Provider | Desktop command | Opens the right folder | Manual steps |
|---|---|---|---|
| Codex | `cag switch codex --from <source>` | Yes | Paste the printed prompt into the conversation |
| Claude | `cag switch claude --from <source>` | No | Click **Code** → select the printed project path → create a new session → send `Continue.` |
| Cursor | `cag switch cursor --from <source>` | Yes | Paste the printed prompt into the conversation |
| Antigravity | `cag switch antigravity --from <source>` | No | Open the printed project folder yourself, then paste the printed prompt into the agent panel |

Add `--surface interactive` to skip the desktop app entirely and run the provider's terminal CLI instead — Codex, Claude, and Cursor attach the prompt and resume automatically; Antigravity attaches the prompt automatically too but always starts a fresh `agy` conversation (no resume). This requires separate CLI authentication for each provider:

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
# See which desktop apps are installed and which credential tier each CLI would use
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

## Persistent memory

**Design goal: never lose important context, but don't grow forever.** Decisions, constraints, and preferences stay reachable indefinitely, no matter how old they are; everything else compresses progressively the further back it goes, so the context handed to an agent stays bounded in size even as the project's history keeps growing.

Every `cag switch`/`export`/`fork` indexes its checkpoint (manifest + transcript) into a local SQLite database, `.cag/memory.db`, and distills it into durable, queryable memory — so the next agent (any provider) can pick up decisions and constraints from weeks ago without re-reading every past transcript, and without the handoff growing without bound.

- **Index (free).** Every checkpoint's manifest and messages are parsed into the database as part of the normal checkpoint write. No model call, no cost — this is the same token-free guarantee Phase 1 already made for checkpoint creation.
- **Consolidate (best-effort).** After the checkpoint is written, `cag` asks the cheapest ready provider (via the same router `cag run` uses) to extract durable facts — decisions, constraints, preferences — each tagged with an importance score (1–10), plus a short summary of that checkpoint. If no provider is ready or the model's output can't be parsed, the checkpoint is queued and retried on the next switch; it never blocks or fails the command.
- **Compact (bounded, nothing important lost).** The most recent 8 checkpoints stay verbatim. Older ones are represented by their per-checkpoint summary; once 10 of those accumulate, they roll up into one epoch digest; once 5 epochs accumulate, those roll up into one project digest. Rolled-up summaries are marked superseded, not deleted — `cag memory search --include-superseded` (or `show`) can still reach them. **Durable facts (decisions/constraints/preferences) are a separate table and are never rolled up or expire** — they stay in every future HANDOFF.md verbatim until a newer fact explicitly supersedes them.
- **Assemble.** HANDOFF.md gains an additive `## Project memory` section — durable decisions, the most relevant retrieved history for the current objective, and the latest digest — capped to a token budget (~3k tokens by default) so context never grows unbounded. When memory has nothing to say (fresh project, or `memory.enabled: false`), the section is omitted entirely and HANDOFF.md is byte-identical to the Phase 1 format.
- **Query.** Any agent (any provider) can query memory directly, mid-session, over the shell or MCP — see below.

```bash
cag memory search "auth middleware rewrite" --kind semantic --limit 5
cag memory show <checkpoint-id-or-item-id>
cag memory stats
cag memory compact              # drain the consolidation queue and run any due rollups by hand
cag memory reindex [--rebuild] [--embed]
```

`cag memory reindex` backfills the database from `.cag/checkpoints/*` — useful after upgrading `cag` in an existing project, or with `--rebuild` to recompute everything from scratch (checkpoint files on disk are always the source of truth; nothing in the database is unrecoverable).

### Search: keyword now, optional semantic later

Search runs on SQLite FTS5 (BM25 keyword ranking) by default — no extra setup. Results are re-ranked by a blend of relevance, recency (exponential decay), and importance.

If a local [Ollama](https://ollama.com) with `nomic-embed-text` is reachable (`http://localhost:11434` by default, probed with a 300 ms timeout so a missing Ollama never slows anything down), `cag` automatically layers in vector search and fuses the two rankings with [reciprocal rank fusion](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html) — this catches conceptually related results that share no keywords (e.g. a query about "login flow" surfacing a past decision about "OAuth2"). Run `ollama pull nomic-embed-text` once, then `cag memory reindex --embed` to backfill vectors for existing memory; new items are embedded automatically after that. Nothing changes if Ollama isn't installed — it's fully optional. Embedding-model changes are handled safely: vectors are tagged with the model that produced them, and a mismatched model is treated as absent rather than compared across incompatible spaces.

### MCP server

`cag mcp [--cwd PATH]` serves the same memory tools over an [MCP](https://modelcontextprotocol.io) stdio server (hand-rolled JSON-RPC 2.0, no SDK dependency), for agents that support MCP tool calls natively instead of shelling out:

```bash
# Claude Code
claude mcp add cag-memory -- cag mcp --cwd /path/to/project

# Cursor: .cursor/mcp.json
{ "mcpServers": { "cag-memory": { "command": "cag", "args": ["mcp", "--cwd", "/path/to/project"] } } }
```

Tools: `memory_search(query, kind?, limit?)`, `memory_get(selector)`, and `memory_save(text, kind, category?, importance)` — the last lets an agent record a durable fact immediately, mid-session, without waiting for the next checkpoint's consolidation pass.

### Configuration

All of the above is tunable under `memory` in `gateway.config.json` (see `gateway.config.example.json`): `enabled`, `verbatimCheckpoints` (default 8), `epochSize` (10), `projectDigestEpochs` (5), `consolidationTokenCapChars`, `consolidationTimeoutMs` (30s — consolidation has its own timeout so a slow provider can't make `switch` feel hung; it just gets queued), `queueDrainLimit`, `budget.*` (per-section character caps in HANDOFF.md), `scoring.*` (recency/importance/relevance weights), and `embeddings.*` (Ollama URL and model). Set `memory.enabled: false` to disable everything and keep pure Phase 1 behavior.

## Phase boundary

Phase 1 shipped file-backed checkpoints and lineage. Phase 2 shipped the persistent memory system above — SQLite index, FTS5/hybrid retrieval, and bounded recursive summarization — while keeping the Phase 1 handoff file format stable.

Provider integrations follow the official automation surfaces: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive), [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), and [Cursor headless CLI](https://docs.cursor.com/en/cli/headless). Antigravity's `agy` CLI (`agy --print`/`agy --prompt-interactive`) is not yet wired into `cag run`'s adapter/routing system and cannot be used as a `--from` source, since there is no local session discovery for it; it is currently reachable only through `cag switch`/`fork --surface interactive`.
