# mixai

**Seamlessly move your work between AI coding agents — Claude Code, Codex, Cursor, and Antigravity — without losing context.**

mixai is a local-first command-line tool that works alongside the coding agents you already use. When you hit a usage limit, want a second opinion, or simply prefer a different agent for the next task, mixai hands off your work — full context intact — in a single command. It also gives every agent a shared, persistent memory of your project's decisions and history, so no agent ever starts from scratch.

Everything runs on your machine. Your credentials never leave your computer, and creating a hand-off never spends a single token.

## Why mixai

- **🔀 Switch agents in one command.** `mixai switch codex` checkpoints your current Claude session and opens Codex right where you left off. Round-trip freely between all four agents — Claude ↔ Codex ↔ Cursor ↔ Antigravity.
- **🧠 Shared project memory.** Decisions, constraints, and preferences are captured once and made available to every agent. Ask any agent "why did we choose X?" and the answer is already in context — no re-explaining, no re-reading old transcripts.
- **✂️ Smaller prompts, lower cost.** Memory stays bounded and is compressed as it ages; search returns compact previews instead of walls of text. A built-in ledger shows exactly what each agent spends and what mixai's compression saves — measured, not guessed.
- **♻️ Survives context resets.** When an agent compacts or clears its context window, mixai restores the important parts instantly from local memory — no expensive re-exploration of your repository.
- **🔌 Works with your existing tools.** mixai orchestrates the native agent apps and CLIs you already have. It doesn't replace them, relay your credentials, or lock you in.

## Requirements

- **Node.js 22.5 or newer.** Persistent-memory features use Node's built-in SQLite.
- **At least one supported agent** installed and signed in: Claude Code, Codex, Cursor, or Antigravity.
- **macOS** for one-click desktop hand-offs. Other platforms use the agents' terminal CLIs (`--surface interactive`).

## Installation

```bash
npm install -g mixai-cli
mixai status      # see which agents are installed and ready
```

`npm install` sets up the `mixai` command globally, but it doesn't wire mixai into any project — that's a separate, per-project step, and it doesn't happen automatically:

```bash
cd your-project
mixai integrate    # once per project: hooks, MCP registration, and instruction files
```

This installs mixai into that project's agent config (`.claude/`, `.codex/`, `.cursor/`, and Antigravity's global `~/.gemini/GEMINI.md`) so hand-off, memory, and context restoration happen automatically as you work — see [Automatic integration](#how-it-works) below. Without it, mixai still works, but only when you invoke it yourself (`mixai switch`, `mixai run`, `mixai memory search`, ...). Run `mixai integrate --check` anytime to confirm a project is still wired up correctly.

### Hit a usage limit? Just switch

If an agent's usage limit, rate limit, or quota kicks in mid-task — a real desktop-app account can hit this independently of any CLI credentials — switch to whichever other agent still has room. Your objective, git state, and conversation carry over, so you're not re-explaining anything:

```bash
mixai switch codex      --from claude   # Claude hit its limit — pick up in Codex instead
mixai switch cursor     --from codex    # Codex is out of quota — try Cursor
mixai switch claude     --from cursor   # ...or back to Claude, if it's recovered
mixai switch antigravity --from claude  # continue in Antigravity
```

**NOTE:** Follow the instructions in the command's output, copy and paste them into the open desktop app to continue your work.


## Quick start

```bash
# Hand off your latest Codex work to Claude Code
mixai switch claude --from codex

# Route a one-off task; the best available agent is chosen for you
mixai run "Explain the architecture and flag the riskiest module"

# Let the agent edit your project (read-only by default)
mixai run --write "Add input validation and tests"

# Ask your project's memory a question
mixai memory search "why did we pick Postgres over Mongo"
```

## Commands

**Working across agents**

| Command | What it does |
|---|---|
| `mixai status` | Show which agents are installed, authenticated, and ready |
| `mixai run "<task>"` | Route a task to the best available agent (`--write` to allow edits, `--provider <name>` to pin one) |
| `mixai switch <agent>` | Checkpoint current work and open another agent to continue it |
| `mixai fork <agent>` | Like `switch`, but branches a separate conversation and leaves the original untouched |
| `mixai export` | Save a hand-off checkpoint without opening another agent |
| `mixai sessions` | List local agent sessions for this project |
| `mixai brief` | Print a fast context brief — objective, git state, relevant memory — with zero token cost |

**Project memory**

| Command | What it does |
|---|---|
| `mixai memory search "<query>"` | Search project memory: decisions, past work, transcripts |
| `mixai memory show <id>` | Show a full memory record |
| `mixai memory stats` | Overview of what's stored, spent, and saved |
| `mixai memory spend` | Token/cost breakdown by agent, purpose, or day |
| `mixai memory savings` | Measured token savings from mixai's compression |
| `mixai memory compact` | Run memory consolidation and roll-ups by hand |
| `mixai memory reindex` | Rebuild memory from checkpoint files |

**Integration**

| Command | What it does |
|---|---|
| `mixai integrate` | Wire mixai into your agents so memory and hand-off work automatically (`--check`, `--remove`) |
| `mixai mcp` | Serve memory and hand-off tools over MCP for agents that speak it |


## How it works

**Token-free checkpoints.** Every hand-off writes a checkpoint to `.mixai/` — the objective, the conversation, git status, and a patch of your changes. No model is called, so it works even after an agent's quota is exhausted. Your repository stays the source of truth; the checkpoint is just a portable hand-off bundle.

**Persistent memory that stays small.** Each checkpoint is indexed into a local SQLite database and distilled into durable facts (decisions, constraints, preferences) plus a short summary. Recent history is kept verbatim; older history is progressively compressed into digests, while durable facts never expire. An agent can pick up a decision from weeks ago without the context ever growing unbounded. Search works out of the box via SQLite's [FTS5](https://www.sqlite.org/fts5.html) full-text index with BM25 relevance ranking, and layers in semantic search automatically if a local [Ollama](https://ollama.com) is available.

**Cost transparency.** mixai records every model call it makes with exact token counts where the provider reports them, and measures the token savings from its own compression. `mixai memory spend` and `mixai memory savings` give you the real numbers — not marketing percentages.

**Automatic integration (optional).** `mixai integrate` wires mixai into each agent's lifecycle hooks so memory updates as you work, context is restored after a compaction or reset, and — when you hit a limit — the agent can check which other agents are ready and offer to switch. Every change is an idempotent, reversible edit to your project's agent config; `mixai integrate --remove` undoes all of it.

## Editor & MCP integration

Agents that speak [MCP](https://modelcontextprotocol.io) can call mixai's tools directly instead of shelling out. `mixai integrate` sets this up for you, or register it manually:

```bash
# Claude Code
claude mcp add mixai-memory -- mixai mcp --cwd /path/to/project

# Cursor: .cursor/mcp.json
{ "mcpServers": { "mixai-memory": { "command": "mixai", "args": ["mcp", "--cwd", "/path/to/project"] } } }
```

Exposed tools: `memory_search`, `memory_get`, `memory_save`, `context_brief` (rebuild working context after a reset), and `list_handoff_targets` / `switch_to_provider` (see which other agents are ready and hand off to one, gated by your editor's own approval prompt).

## Configuration

Optional — everything has sensible defaults. Copy `gateway.config.example.json` to `gateway.config.json` to tune agent routing, memory limits, hook behavior, and embeddings. The file is gitignored, since commands and model choices are often machine-specific.

## Privacy

- **Nothing is uploaded.** All data lives in `.mixai/` inside your project, which is gitignored by default.
- **Credentials are never copied or relayed** — each agent uses its own local login.
- **Checkpoints and briefs never call a model,** so they cost nothing and work offline.

## Development

```bash
git clone https://github.com/thinhledev/mixai
cd mixai
npm install
npm run build
npm test
npm link          # use your local build as the global `mixai` command
```

Provider integrations follow each vendor's official automation surface: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive), [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/cli-usage), and [Cursor headless CLI](https://docs.cursor.com/en/cli/headless).

## License

[MIT](LICENSE) © Thinh Le
