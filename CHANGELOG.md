# Changelog

## 2.0.0

**Renamed from mixai to simem** (npm package `simem`, command `simem`, data in `~/.simem`). mixai 1.x projects upgrade in place: `simem init` migrates the old `.mixai/` memory, and `simem integrate` replaces mixai's per-project entries.

simem is now a local memory and context-compression layer for the Claude Code and Codex apps. Agent switching stays, as an extra.

### Added
- **One-time, user-level install** (`simem init`): hooks, MCP tools, and instructions for every Claude Code and Codex account on the machine, through a pinned launcher so the desktop apps don't depend on PATH. Byte-stable hook entries keep Codex trust approvals valid across upgrades. `--check`, `--remove`, `--statusline`.
- **Shared, account-independent memory**: one store per project in `~/.simem/projects/<id>`, identified by the repository's root commit (shared by every clone and worktree).
- **Continuous capture**: sessions are ingested as they happen (Stop, SessionEnd, PreCompact) from every agent account, with real token usage, tool events, titles, and app summaries; `simem sync` imports history. Claude Code auto-memory, the Claude app's session summaries, and Codex memories are imported.
- **Zero-token memory building**: deterministic rules extract the user's decisions, constraints, preferences, corrections, and TODOs; template session summaries; extractive rollups. Optional local Ollama or opt-in remote tiers.
- **Built-in local embeddings** (Model2Vec potion-base-8M, pure TypeScript, downloaded and checksum-verified by `init`): deliberate search recall on reworded questions 42% → 75% on the labelled set (`simem eval`).
- **Session-start primer** with the latest work from any agent, standing decisions, user-wide preferences, known build/test commands, and repo layout; per-session injection dedupe.
- **Local code index**: `code_search`, `code_read`, `repo_map`; `code_outline` returns symbol ranges.
- **Output compression**: `simem exec`, `simem out`, `output_get`; automatic for Claude Code commands your settings already allow.
- **Read guards**: outline-first for large full reads, flagging unchanged re-reads (once each).
- **Visibility**: `simem stats`, `simem dashboard`, MCP `memory_stats` / `simem_doctor` / `recall` / `memory_forget`, Stop notice in Claude Code, optional status line, `simem doctor`.
- **Portability**: `simem memory export` / `import`, `memory.syncDir` with optional AES-256-GCM encryption.
- Secret redaction on everything stored or shown; `mcp.toolGroups`; `~/.simem/config.json`.
- Plugins for both apps sharing the `simem` and `simem-setup` skills: Claude Code (`.claude-plugin/marketplace.json`) and Codex (`.agents/plugins/marketplace.json`).
- Standalone binary (no Node.js needed) for macOS and Linux, built per platform in CI and installed with `install.sh`.

### Changed
- Requires Node.js 22.5 or newer.
- Per-prompt memory injection matches natural-language questions (1.0.6) and never repeats an item within one context window.
- `simem status` is `simem doctor` plus handoff readiness.
- mixai 1.x in-repo memory (`.mixai/`) is copied into the shared store on first use; the old files are left untouched. Per-project hooks and MCP entries from `simem integrate` stay but go quiet once `init` covers that agent; mixai 1.x entries are replaced by `simem integrate` and removed by `simem integrate --remove`.
- The rules tier now runs by default instead of paid LLM consolidation (`memory.distill.remote` opts back in).

### Fixed
- Vector search ranked only the first rows in table order.
- The outliner reported `if (…) {` / `for (…) {` lines as methods.
- `integrate --remove` left an extra blank line behind.

### Deprecated
- `simem run` and `routing.*`; removal planned for 3.0.

## 1.0.6
- Fixed per-prompt memory injection never matching natural-language prompts.
