# simem 2.0: memory-first plan

*This project was called **mixai** through 1.x and was renamed to **simem** for 2.0. References to 1.x below mean mixai 1.x; its in-repo folder was `.mixai/`.*

## Implementation status (2.0.0, branch `release/2.0.0`)

All phases are implemented. 232 tests pass. Each phase is its own commit.

| Phase | Status |
|---|---|
| 0 Repositioning | Done: help text and package metadata, `run` deprecated, `status` = doctor + handoff readiness |
| 1 App-first install, shared store, ingestion | Done |
| 2 Local-first distillation | Done, including the app summaries, global scope, and procedural memory that were deferred earlier |
| 3 Vectors, primer, sanitization | Done |
| 4 Code index | Done |
| 5 Compression and guards | Done |
| 6 Visibility | Done |
| 7 Portability | Done |
| 8 Distribution and docs | Done: README, CHANGELOG, config example, Claude Code and Codex plugins (installed with each app's own CLI in sandboxes), standalone binary build (bundle verified end to end; CI builds per platform) |

**Where the implementation differs from the plan, and why:**

1. **Vector storage.** Vectors are float32 BLOBs in the existing `memory_items` / `summaries` / `chunks` columns, not packed one-byte segments. An exact scan was measured fast enough at this scale, and it avoided a second storage format.
2. **The built-in model's role in automatic injection.**
   - `potion-base-8M` similarity doesn't separate relevant from off-topic prompts (an off-topic prompt scored 0.51 against a calibrated cutoff of 0.52). So the vector path of the automatic-injection gate is off by default (`memory.embeddings.minSimilarity` / `strongSimilarity` = 0), and `simem eval --all` calibrates it for stronger models.
   - Deliberate search does use vectors: top-3 recall on reworded questions went from 42% to 75%, which meets Phase 3's ≥70% target for deliberate search. Automatic injection on reworded questions stays at 8%, keyword-gated, with 0 false injections.
3. **`code_find_references`** stays a full scan. The index doesn't hold every line of every file, and a reference missed during a rename is worse than a slower scan.
4. **Bash rewrite.** In Claude Code, a PreToolUse rewrite must be paired with `"allow"`, which skips the permission prompt. So simem only rewrites when the user's own settings would auto-approve the command anyway: bypass mode, or an allow rule with no deny/ask match, a simple command, and not plan mode. Codex also requires `"allow"` and has no Read tool, so Codex gets no PreToolUse hook; it uses `simem exec` through its instructions.
5. **Migration** copies the mixai 1.x store and leaves the old `.mixai/` files untouched (marked `MIGRATED.txt`) instead of renaming them. A mixai 1.x still installed elsewhere keeps working instead of starting an empty database, and `doctor` warns if the old file keeps changing.
6. **Cursor** gets user-level MCP only; its hooks still come from per-project `integrate`. **Antigravity** has no user-level install (no hooks or MCP surface).
7. **Not imported:** `CLAUDE.md` / `AGENTS.md` / `.cursor/rules`. Every agent already reads them natively from the repository.
8. **Claude Code plugin** ships skills (`simem`, `simem-setup`), not hooks or MCP, so nothing is registered twice alongside `simem init`.
9. **Plugins and binary.** The Codex plugin format was taken from the plugins Codex itself installs (`.codex-plugin/plugin.json`, `skills/`, `.agents/plugins/marketplace.json`); both plugins share one `plugin/` folder and ship skills only. The standalone binary is a Node single-executable build of an esbuild bundle. A binary only runs on the OS and CPU it was built on, so CI builds macOS arm64/x64 and Linux x64/arm64. There is no Windows binary (the launcher is a POSIX script).

**Measured on this repository** (maintainer's machine, read-only sync into a scratch store):
- 8 Claude app sessions re-sent about 1.04B cached tokens.
- Command output (~1.1M tokens over 1,530 calls) and file reads (~430k) dominated what filled the context.
- 141 files index in about 330 ms, embeddings included.
- Output filter reductions on the golden corpus: jest 92%, vitest 99%, pytest 81%, node:test 98%, go test 98%, npm install 99%, tsc errors 0% (every line is a failure, so all are kept).

---


**Status:** proposal, awaiting approval · **Drafted:** 2026-10-11 (rev. 2: app-first) · **Target release:** `simem@2.0.0`

This plan changes simem's main purpose. Switching between agents becomes a secondary feature. The new focus:

1. **Primary: save real provider tokens.** Index the project and its history locally, answer context questions locally, and clean up and shrink whatever context goes to the AI provider.
2. **Secondary: memory that belongs to the project, not to any one account or agent.** Logging out of account 1 and into account 2, moving from Claude Code to Codex, opening a new worktree, or re-cloning the repo should all keep the same memory.
3. **Kept but demoted:** cross-agent handoff (`switch`, `fork`, `export`).

**Primary target: the desktop apps.** Most users code in the **Claude Code app** (the Code tab of the Claude desktop app) or the **Codex app**, not in a terminal. Every feature must work end to end inside those apps with no terminal step after a one-time install, and the agent itself can run that install. The CLI is an alternative way in, not a requirement.

---

## 1. Diagnosis: what we have today

### Worth keeping (most of the codebase)

| Asset | Where | Why it matters for 2.0 |
|---|---|---|
| SQLite store with FTS5/BM25, migrations, and an optional Ollama vector search with RRF fusion | `src/memory/db.ts`, `schema.ts`, `retrieval.ts`, `embeddings.ts` | Right base for local retrieval |
| Durable memory items (kind/category/importance/supersede) plus hierarchical summaries | `consolidate.ts`, `compaction.ts` | Right data model; what needs to change is **who produces it** |
| Transcript readers for Claude Code (CLI and desktop), Codex, and Cursor | `src/handoff/sessions.ts` | Becomes the ingestion layer |
| Hook plumbing (SessionStart, PreCompact, UserPromptSubmit, Stop) and idempotent, reversible config editing | `hooks.ts`, `integrate.ts` | The delivery path into the apps |
| MCP server (memory, brief, code map) | `mcp-server.ts` | The main UI for app users: they *ask the agent*, and the agent calls these tools |
| Code map with zero dependencies | `src/codemap/` | The start of a local code index |
| Token and savings ledgers, built to be honest | `ledger.ts`, `savings.ts` | Keep the "measured, never guessed" principle |

### What's in the way of the new goals (verified on this repo and this machine)

1. **Memory is only captured on a switch, export, or compaction.** All 38 checkpoints in this repo fall between 2026-07-02 and 2026-07-09. The Claude Code app and Codex app sessions after that never got into memory.
2. **Building memory spends provider tokens.** Consolidation runs `codex exec` or `claude -p`. 6 calls sent ~87k chars (≈75.6k input tokens). Recorded savings: ≈550 tokens.
3. **Per-prompt retrieval was broken for natural language. Fixed in 1.0.6.** `ftsQuery` quoted every word and FTS5 ANDed them together, so a prompt only matched when *every* word appeared in one memory row.
   - `"why did we decide to use a CLAUDE.local.md import for the Claude Desktop handoff"` returned **0 hits**, even though memory #17 is exactly that decision.
   - Ranking was position-only (`1/(1+i)`), so there was no absolute relevance floor.
   - **1.0.6** keeps only topic terms, ORs them, scores each hit by IDF-weighted term coverage, and gates automatic injection at ≥50% coverage and ≥2 matched terms.
   - **Still open:** questions worded differently from the stored memory (handled by the vector layer, §4.5) and per-session re-injection (Phase 3).
4. **Memory is tied to one checkout path.** `<repo>/.simem/memory.db` is lost on a re-clone, and both apps run sessions in **worktrees**: the Claude app uses `<repo>/.claude/worktrees/<name>` (`cwd` ≠ `originCwd`), and the Codex app runs threads the same way. Today a worktree only gets `.simem/current/` copied in through `.worktreeinclude`.
5. **Setup assumes a terminal, one project at a time.** `simem integrate` has to be run in a shell for each project, so a new project or a new worktree opened in the app gets nothing. `switch` prints a prompt you have to paste into the app. Stop-hook output ("measured savings…") isn't visible in either app.
6. **Hooks break easily inside GUI apps.**
   - Hook and MCP entries call bare `simem`, which has `#!/usr/bin/env node`. On this machine that resolves through nvm (`~/.nvm/versions/node/v24.13.0/bin`). An app launched with a different PATH, or after an nvm switch, either fails to find it or picks a Node older than 22.5 (no `node:sqlite`).
   - In the Codex app, every project hook needs a trust approval stored as a **content hash** (`~/.codex/config.toml [hooks.state] … trusted_hash`). Each time simem rewrites `hooks.json`, the user is asked again.
7. **Each agent is read through only one account home.** Discovery reads `$CLAUDE_CONFIG_DIR` *or* `~/.claude`, and `$CODEX_HOME` *or* `~/.codex`. A second account in a different config dir is invisible.
8. **Native and app-generated memory is ignored.**
   - Claude Code auto-memory: `<config-dir>/projects/<slug>/memory/*.md`.
   - Claude app session metadata: `~/Library/Application Support/Claude/claude-code-sessions/**.json` has `title`, `postTurnSummary`, `gitAnchors`, `originCwd`. These are free summaries that cost us nothing.
   - Codex app memories: `~/.codex/memories_1.sqlite` → `stage1_outputs(raw_memory, rollout_summary, …)`.
   - Codex rollouts are mixed in with headless runs: 36 of the last 40 are `originator: "codex_exec"` (including simem's own consolidation calls), and only 4 are `"Codex Desktop"`. Ingestion has to tell them apart, or memory fills up with simem's own prompts.
9. **Savings measurement only sees simem's own internals**, although the transcripts carry real usage: Claude has `message.usage` (input, cache create, cache read, output) and Codex has `token_count` events.
10. **No persisted code index**, and **positioning leads with switching** (package description, README hero, `status`, `run`, routing config).

---

## 2. New product definition

**One-liner:** *simem is a local memory and context-compression layer for the Claude Code and Codex apps (and their CLIs). It cuts the tokens you send to the provider and remembers your project across every account, agent, and worktree.*

### Principles

- **App-first.** After the one-time install, nothing needs a terminal. You use simem by talking to your agent ("what did we decide about X?", "remember that…", "how many tokens did we save?"), and through hooks that run on their own.
- **Install once per machine, not per project.** User-level hooks and MCP cover every project, worktree, and new repo automatically.
- **Local only.** No server or cloud service is involved, and credentials are never read or relayed.
- **Zero provider tokens by default** for building, indexing, and querying memory.
- **Send less new content, never rewrite history.** Providers cache the prompt prefix; changing earlier context breaks the cache and raises cost.
- **Measured, not claimed.** Exact figures where possible, estimates always labelled.
- **Lossless escape hatch.** Anything shrunk stays available in full locally.
- **Reversible, toggleable, and doesn't churn approvals.** Hook entries in the agents' config are written once and stay byte-stable; behaviour changes go through simem's config, so the Codex app's trust approvals stay valid.

### Non-goals

- **An API proxy.** It would see credentials, could break subscription terms of service, and rewriting requests breaks prompt caching.
- A hosted sync service or team server.
- Replacing the agents' own compaction.

---

## 3. Where tokens go, and the levers simem can pull

Anything that enters the context is re-sent (as cached input) on every later turn until compaction. A 25k-token file read on turn 3 of a 40-turn session costs roughly 25k × 37 in cache reads. Keeping content *out* compounds. Shaving the user prompt doesn't.

| # | Lever | How | Surface (both apps) | Measured as |
|---|---|---|---|---|
| L1 | **Project primer at session start** replaces initial exploration | Deterministic ≤1.5k-token primer: purpose, stack, layout map, build/test commands, conventions, top decisions, current work (and the other app's last objective, which is how handoff happens). Kept byte-stable so the prefix cache keeps hitting. | SessionStart hook (`startup` as well as compact/resume/clear) | Exploration tokens in a session's first N turns, before vs after |
| L2 | **Local code search** instead of grep+read loops | Persisted index. `code_search` returns `path:line` ranges and signatures. `code_read` returns one symbol body. | MCP plus instructions | Bytes the agent would have read vs bytes returned (estimate) |
| L3 | **Tool-output compression** | `simem exec -- <cmd>` filters test/build/install/git noise and keeps all failure information. Raw output is stored locally and fetched with `output_get`. | PreToolUse rewrite of Bash (`updatedInput`), with an instruction fallback | Exact: raw vs sent |
| L4 | **Large-read guard** | The first full read of a file over N lines gets its outline back plus a request for the needed range. A second identical read goes through. | PreToolUse on Read | Exact |
| L5 | **Unchanged re-read guard** | Same blob hash and no compaction since the last read means "unchanged since turn N" | PreToolUse on Read; reset on compaction | Exact |
| L6 | **Gated memory injection** | Fixed query building (OR plus stopwords plus BM25), an absolute relevance floor, trivial-prompt skip, per-session dedupe, token budgets | UserPromptSubmit | Exact |
| L7 | **Progressive disclosure** (exists) | Previews first, full text on request | MCP | Exact |
| L8 | **Sanitization** | Redacts secrets, normalizes `$HOME` paths, strips noise | Every simem output path | Redaction count |
| L9 | **Zero-token memory building** | Local distillation plus free app summaries (§4.4) | n/a | simem's own provider tokens, which should be 0 |
| L10 | **Lean tool schemas** | Short MCP descriptions, tool groups can be switched off | MCP `tools/list` | Schema chars |

Interop: if [RTK](https://github.com/rtk-ai/rtk) is detected, L3's Bash rewrite steps aside to avoid filtering output twice.

---

## 4. Target architecture

```
  Claude Code app / CLI (account A, B… = any config dir)     Codex app / CLI (any CODEX_HOME)
        │  user-level hooks + MCP (installed once)                 │  user-level hooks + MCP
        ▼                                                          ▼
  ~/.simem/bin/simem  ← pinned launcher (absolute node ≥22.5 + dist path; no PATH reliance)
        │  hook payload cwd / MCP roots → projectId (root commit; worktree-aware)
        ▼
  ┌──────────────────────────── ~/.simem (SIMEM_HOME) ────────────────────────────┐
  │ global.db          projects · path aliases (all worktrees/clones) · global items │
  │ projects/<id>/     memory.db: sessions · usage · events · memory · summaries ·    │
  │                               code index · outputs · injections                  │
  │                    checkpoints/ (handoff bundles, unchanged format)              │
  └──────────────────────────────────────────────────────────────────────────────────┘
        ▲ zero-token ingest: transcripts, Claude app session metadata, Codex memories,
        │ native memory files, from every account home
  Visible surfaces for app users: MCP tools in chat · Claude plugin slash commands ·
  hook systemMessage lines · local dashboard (simem dashboard, 127.0.0.1)
```

### 4.1 Installing into the apps

- **`simem init` installs at user level, once per machine** and per account home it discovers:
  - **Claude Code** (desktop Code tab and CLI share it):
    - hooks in `<config-dir>/settings.json` for SessionStart, UserPromptSubmit, PreToolUse (`matcher: "Bash|Read"`), PreCompact, Stop, SessionEnd
    - a user-scope MCP server (the file the app reads, `~/.claude.json` or equivalent; verify that the desktop app picks up user scope)
    - a short instruction block in `<config-dir>/CLAUDE.md`
  - **Codex** (app and CLI share `CODEX_HOME`):
    - `[mcp_servers.simem]` in `~/.codex/config.toml`
    - user-level hooks (verify the file and its trust behaviour; fall back to per-project `.codex/hooks.json` if user-level hooks aren't supported)
    - an instruction block in `~/.codex/AGENTS.md`
  - Every entry points at the **pinned launcher** `~/.simem/bin/simem`, never a bare `simem`.
- **Pinned launcher:** a small shell shim written at install time that execs an absolute path to Node ≥22.5 plus the absolute `dist/cli.js`.
  - It survives nvm switches, GUI PATH differences, and Homebrew/nvm mixes.
  - `simem doctor` checks it, and `simem init` rewrites it after an upgrade.
  - Later option: a standalone binary built with Node SEA, so app users don't need a Node toolchain (§6, Phase 8).
- **Hook entries never change after install:** one dispatcher command per event (`~/.simem/bin/simem hook <event>`). Everything else is decided at runtime from config, so the Codex app's `trusted_hash` approvals stay valid across simem upgrades.
- **Finding the project at runtime:** hooks read `cwd` from the payload. The MCP server uses `--cwd` if given, then MCP `roots/list`, then `process.cwd()`. Verify what each app passes for worktree sessions.
- **Onboarding without a terminal:** the README's first instruction is a sentence to paste into either app: *"Install and set up simem: run `npm i -g simem && simem init`, then restart this app."* The agent runs it with its own shell tool. Phase 8 adds a **Claude Code plugin** (marketplace: hooks, MCP, and slash commands `/simem:recall`, `/simem:remember`, `/simem:stats`) installable from the app's plugin UI, and a Codex plugin if its plugin format allows hooks and MCP (verify).
- **Per-project `simem integrate` stays available** for teams that want repo-level config. It isn't required, and it no longer writes the `CLAUDE.local.md` `@BRIEF.md` import or `.worktreeinclude` entries by default, because the SessionStart primer replaces them.

### 4.2 Storage layout and project identity

- **Global home:** `~/.simem/` (override with `SIMEM_HOME`), mode `0700`/`0600`.
  - `global.db`: `projects`, `project_paths`, `global_items`
  - `projects/<projectId>/memory.db` plus `checkpoints/`
  - `config.json`, with an optional per-project override at `<repo>/.simem/config.json` (`gateway.config.json` is still read, with a deprecation note)
- **How `projectId` is resolved** (first match wins):
  1. A pinned id in `<repo>/.simem/project.json`.
  2. The git **root commit SHA**, which is the same for every worktree (`.claude/worktrees/*`, Codex threads), clone, machine, and rename.
  3. The normalized `origin` URL.
  4. A hash of `realpath` (non-git directories).
  Worktrees resolve through `git rev-parse --git-common-dir`.
- `simem project show|list|link|unlink` (also available as MCP tools, so it works from chat).
- `memory.storage: "global" | "project"` (`project` keeps the 1.x in-repo layout).

### 4.3 Sources: ingestion that doesn't depend on the account

- **Discovering homes** (`simem sources`, and in the dashboard):
  - Claude: `$CLAUDE_CONFIG_DIR`, `~/.claude`, `~/.claude-*`, plus the Claude app session metadata dir
  - Codex: `$CODEX_HOME`, `~/.codex`, `~/.codex-*`
  - Cursor: `~/.cursor`
  - Antigravity: discovery only
  - plus `sources.extraDirs`
  - Each source is labelled by agent, directory, and surface (`claude-app`, `claude-cli`, `codex-app`, `codex-exec`). We never read emails or tokens.
- **Telling sessions apart:**
  - Claude app sessions: a `cliSessionId` match in `claude-code-sessions`.
  - Codex: `originator` (`Codex Desktop` vs `codex_exec`).
  - simem's own headless runs are excluded (consolidation-prompt signature and a `SIMEM_INTERNAL=1` env marker on every child simem spawns).
  - Other `codex_exec` / `claude -p` runs are kept but labelled `headless`, with lower importance.
- **Incremental:** an `ingest_cursors` table (path, inode, offset, mtime). Triggers:
  - Stop and SessionEnd hooks, so every app turn feeds memory
  - PreCompact
  - a cheap stat check on any hook or MCP start
  - `simem sync [--since 90d] [--all-projects]` for the one-time backfill, which `init` runs too
  - Heavy work always goes to a detached background child, so hooks return fast.
- **What gets captured:** user and assistant text, **turn usage**, **events** (read/edit with path and size, command with exit code, search, MCP call, error signature), and tool outputs as hash + size + head/tail only.
- **Free summaries imported** (`origin=app`, idempotent by content hash):
  - Claude app `title` and `postTurnSummary`
  - Codex `stage1_outputs.rollout_summary` and `raw_memory`. That schema is undocumented, so reads are guarded by the `_sqlx_migrations` version, are read-only, and fail softly.
- **Native memory files imported:**
  - Claude auto-memory dirs under every home, `CLAUDE.md` / `CLAUDE.local.md` (excluding simem blocks)
  - `AGENTS.md`, `.cursor/rules/*.mdc`

### 4.4 Distillation (local first, zero tokens by default)

| Tier | Default | What it does |
|---|---|---|
| **T0 rules** | on | Deterministic extraction of user decisions, constraints, preferences, and corrections. Successful build/test commands become procedural memory; error signatures are paired with the fix that resolved them; TODOs. Each session gets a template summary (objective, outcome, files, commands, errors). |
| **T0.5 app summaries** | on | Claude app `postTurnSummary` / `title` and Codex `rollout_summary` / `raw_memory` become session summaries and candidate items, at no cost |
| **T1 agent-authored** | on | Instructions so the agent calls `memory_save` the moment a decision is made, or when the user says "remember…" |
| **T2 local LLM** | auto if Ollama has a chat model | Summary polish, merging duplicates, suggesting supersedes |
| **T3 remote agent** | **off (opt-in)** | Today's consolidation behaviour, with every call logged |

- **Dedupe:** normalized hash, plus cosine above 0.92 when vectors exist. A match **reinforces** the existing item instead of inserting.
- **Global scope:** "in all projects" statements, or preferences seen in 2+ projects, go into `global_items`. `promote|demote` by hand, or from chat.

### 4.5 Retrieval and injection: hybrid keyword + built-in vector layer

**Keyword half (shipped in 1.0.6):**
- Drop stopwords and question-framing words, split identifiers the way the FTS tokenizer does, and OR the remaining terms.
- Score each hit by IDF-weighted coverage of the query's terms, using SQLite's own stemming.
- Automatic paths require ≥50% coverage and ≥2 matched terms. Deliberate searches have no floor.
- This half is precise on exact names (`CLAUDE.local.md`, `open -a`) and on unknown topics: a term no memory contains lowers coverage, so nothing gets injected.
- What it can't do is match a question worded differently from the stored memory: "why does the app open the wrong window" shares no words with "routes Claude Desktop to Cowork", and "decide" doesn't stem to "decision". The vector half covers that.

**Vector half (`simem-vec`), built in and working without Ollama:**
- **Storage: inside the existing `memory.db`, not a new engine.** SQLite already gives crash safety, WAL concurrency for the Claude app and Codex app writing at the same time, FTS5, and a single file built into Node.
  - Vectors are stored at one byte per number, packed into blocks of 1,024 in a `vector_segments(id, model, dim, count, owner_refs, data)` table.
  - A `vector_queue` table holds rows still waiting to be embedded.
  - Search is an exact brute-force scan in TypeScript. Measured with 256-d vectors: 1k vectors 0.5 ms, 50k 23 ms, 200k 95 ms.
  - The injection path only scans memory items and summaries, so it stays around a millisecond.
  - An approximate index (the `sqlite-vec` extension, behind the same interface) only comes in if a project passes ~200k vectors.
- **Embedding model: built-in static embeddings.** Hooks are a fresh process for every prompt, inside GUI apps, with no GPU and no guaranteed Ollama, so the model has to load instantly and run in pure TypeScript.
  - Default: Model2Vec **`potion-base-8M`**. MIT license, 256 dimensions, BGE-base English tokenizer, about 92% of `all-MiniLM-L6-v2` on MTEB.
  - Inference is: split into word pieces, look up a fixed vector per piece, average, normalize. That's about 150 lines of TypeScript (word-piece tokenizer plus `safetensors` reader), with no native or ONNX dependency. Loading is one file read, and embedding a sentence takes microseconds.
  - The weights are 30.2 MB as stored, about 7.5 MB at one byte per number. `simem init` downloads them once into `~/.simem/models/` with a pinned SHA-256, and everything works offline after that.
  - Optional upgrades: `potion-retrieval-32M` (tuned for search, about 32 MB at one byte per number), or Ollama, which simem already supports. Ollama with `bge-m3` is the path for users who prompt in a language other than English, such as Vietnamese, because an English-only model can't match a Vietnamese prompt to English memories.
- **Embedding happens when memory is written**, in the background (`vector_queue`), costing zero tokens. Changing the model re-embeds everything in the background (the existing `embedMissing` grows into this).
- **Combined ranking and gate:**
  1. Candidates come from both sides: the top 50 by keywords and the top 50 by vector similarity.
  2. Each candidate is scored on coverage, cosine similarity, BM25, recency, and importance.
  3. **Automatic injection passes** if coverage ≥ 0.5 (keyword match), **or** cosine ≥ τ and coverage ≥ 0.2 (worded differently but anchored to at least one topic term), **or** cosine ≥ τ_high (pure meaning match, set strict).
  4. Then a relative cut to the top hit, and removal of near-duplicates (MMR).
  - Vectors alone would turn "never fires" into "always fires", because nearest-neighbour search always returns something. That's why vector-only matches need the strict τ_high.
- **Calibrated cutoffs, not hand-picked ones.** Static embeddings give unrelated sentences fairly high similarity, so τ and τ_high are set per model from a labelled set by `simem eval` and stored with the model id.
  - Each cutoff is chosen as the lowest that keeps precision ≥0.9 on the labelled set.
  - The labelled set mixes real prompts and reworded versions taken from this repo's memory, plus filler and off-topic prompts that must inject nothing.
- **Reused by the code index** (§4.6) for chunk embeddings, and by distillation (§4.4) for detecting duplicate memories.

**Injection behaviour (both halves):**
- **Prompt gate:** no injection for short or continuation prompts (1.0.6 already returns nothing when no topic terms remain).
- **Session dedupe** through the `injections` table, cleared on compaction.
- **Token budgets** through one shared `estTokens()`, calibrated against real `usage`.
- **SessionStart primer (L1)**, injected on `startup`, `resume`, `clear`, and `compact`:
  - It includes the latest objective and outcome from *any* agent or app, so opening the Codex app after the Claude app (or after switching accounts) just continues. No `switch` command and no pasting.
  - It's cached on disk and rebuilt only when inputs change.

### 4.6 Code index

- Incremental through `git ls-files -s` blob SHAs (untracked files by mtime). Respects `.gitignore`, skips binaries, lockfiles, build output, minified files, and large files.
- Heuristic outliner (now with symbol end lines) as the default. `web-tree-sitter` as an optional backend.
- Deterministic per-file summaries feed the primer and `repo_map`.
- **MCP tools:** `code_search`, `code_read`, `repo_map`, plus index-backed `code_outline` and `code_find_references`.
- Indexing runs in a background child, triggered by SessionStart and Stop, so it never blocks the app.

### 4.7 Compression and sanitization

- **`simem exec -- <cmd>`:**
  - Filters by command signature: jest/vitest/mocha/node:test, pytest, go test, cargo, tsc/eslint, npm/pnpm/yarn/pip, git, docker, plus a generic filter.
  - Exit code preserved, failure information never dropped.
  - Adds a `[simem: 41,220 → 2,310 chars · raw: output_get 7f3a]` footer.
- **PreToolUse rewrite** in Claude Code (both app and CLI) through `updatedInput`, scoped by `matcher: "Bash"`. For Codex, verify PreToolUse support and `updatedInput`, and fall back to instruction text.
- **Guards L4 and L5:** `off | suggest | enforce`, each set separately.
- **Redaction:** one `sanitize()` on every ingest and injection path.

### 4.8 Visibility for app users

App users won't run `simem stats` in a terminal, so every insight has an in-app path:

- **In chat:** MCP tools `recall`, `memory_save`, `memory_forget`, `memory_stats` (spend, savings, x-ray), `simem_doctor`. The instruction block maps plain phrases to them ("what did we decide…" → `recall`; "how much did we save" → `memory_stats`).
- **Claude plugin slash commands** (Phase 8): `/simem:recall`, `/simem:remember`, `/simem:stats`, `/simem:forget`.
- **Hook `systemMessage`:** a one-line saving notice at Stop, rate-limited to once per session or above a threshold. Verify how each app displays it; it's off where it's invisible.
- **Local dashboard:** `simem dashboard` serves on `127.0.0.1` with a random-token URL, and the agent can open it. It has a memory browser with edit, forget, and promote; a sources and accounts view; spend and savings charts; and a guard log.
- **CLI:** the same data through `simem stats`, for terminal users.

### 4.9 Measurement

- Real provider usage from `turn_usage`, broken down by app/CLI, account source, agent, day, and session.
- **X-ray:** which tool results grew the context.
- **Savings:** direct (exact) and compounded (an estimate, labelled).
- **Baseline:** backfilled history gives a "before simem" figure on day one. The before/after comparison is observational, and says so.

### 4.10 Integration surfaces

| Surface | Claude Code app (+ CLI) | Codex app (+ CLI) | Cursor | Antigravity |
|---|---|---|---|---|
| Install scope | user (`<config-dir>/settings.json`, user MCP), per account home | user (`~/.codex/config.toml`, hooks: verify user scope) | project | global `GEMINI.md` |
| Instructions | `<config-dir>/CLAUDE.md` block | `~/.codex/AGENTS.md` block | `.cursor/rules` | `~/.gemini/GEMINI.md` |
| SessionStart primer | ✓ (verify the `startup` source in the app) | verify | verify | none |
| UserPromptSubmit | ✓ | ✓ (verify it runs in the app; partly unproven in July testing) | verify | none |
| PreToolUse rewrite/guards | ✓ `updatedInput` | verify | verify | none |
| PreCompact / Stop / SessionEnd | ✓ | PreCompact ✓ (proven in the app), Stop verify | `stop` | lazy ingest |
| Free summaries | `postTurnSummary`, `title` | `memories_1.sqlite` | none | none |
| Trust/approval behaviour | settings-file hooks run without a prompt | per-hook `trusted_hash` → keep entries byte-stable | n/a | n/a |

"verify" means test it in the **app** (not only the CLI) before shipping. Unverified surfaces ship behind flags and show in `doctor` and the dashboard.

---

## 5. Surface (2.0)

**In chat (MCP, the main UI for app users)**
- memory: `recall` (`memory_search` stays as an alias), `memory_get`, `memory_save`, `memory_forget`, `memory_stats`, `context_brief`
- code: `code_search`, `code_read`, `code_outline`, `code_find_references`, `repo_map`
- compression: `output_get`
- setup: `simem_doctor`, `project_show`
- handoff: `list_handoff_targets` and `switch_to_provider`, only when `handoff.enabled` (on by default). Mostly unnecessary once both apps get the primer.
- `mcp.toolGroups` lets users switch off whole groups (L10).

**CLI (one-time setup and power users)**

| Command | Purpose |
|---|---|
| `simem init` | User-level install into every discovered Claude/Codex home, pinned launcher, 1.x migration, `sync` backfill, first index, baseline |
| `simem doctor` | Launcher and Node check, hooks installed and verified per app, sources, index freshness, guards fired |
| `simem dashboard` | Local web UI (§4.8) |
| `simem recall` / `stats` | Same as the MCP tools |
| `memory …`, `sync`, `sources`, `project …`, `index`, `exec`, `out` | Power-user and debugging commands |
| `switch`, `fork`, `export`, `sessions`, `brief` | Handoff (demoted, unchanged) |
| `integrate` | Optional per-project install |

**Deprecated:** `run`, `routing.*`, and provider routing in `status` (`status` becomes an alias for `doctor`). They stay in 2.x and are removed in 3.0.

---

## 6. Roadmap

Each phase ships on its own. Every acceptance check is run **in the Claude Code app and the Codex app**, not only in the CLI.

### Phase 0: repositioning groundwork
- Package description and keywords, `--help` ordering, `run` deprecation, `status` → `doctor`.

### Phase 1: app-first install and account-independent store
- `src/store/home.ts`, `src/store/project-id.ts` (worktree-aware), `global.db`, `project` commands.
- **Pinned launcher**, plus **user-level install** for Claude (every config dir) and Codex, with byte-stable dispatcher hook entries.
- Automatic, reversible 1.x migration.
- `src/sources/` (multi-home discovery, app vs CLI vs headless labelling, excluding simem-internal runs), `ingest_cursors`, sessions/usage/events ingestion, native memory import, Claude app metadata import, Codex memories import (guarded).
- Stop/SessionEnd ingest (detached), `simem sync`.
- **Done when:**
  - after `init`, a **brand-new project and a new app worktree** get memory with no per-project step
  - memory written in the Claude app under account A is recalled in the Claude app under account B (a different config dir) and in the Codex app
  - hooks still work after an nvm Node switch
  - upgrading simem doesn't trigger new Codex trust prompts
  - re-running `sync` is a no-op

### Phase 2: local-first distillation
- T0 rules, T0.5 app summaries, dedupe/reinforce, global scope, optional T2 Ollama, remote consolidation behind opt-in.
- **Done when:** default config shows 0 simem provider calls; on a labelled corpus, rules recall ≥70% of decisions, constraints, and preferences at ≥85% precision; duplicates reinforce.
- **Status (branch `phase-2/local-distillation`): done except the parts that depend on Phase 1.**
  - **Delivered:**
    - T0 rules: `src/memory/distill/rules.ts`, covering user constraints, preferences, decisions, corrections, and TODOs, plus a template summary.
    - Dedupe and reinforce with schema v5 (`origin`, `content_hash`), through `src/memory/items.ts`.
    - The optional T2 tier through `memory.distill.ollamaModel`, and the T3 remote tier behind `memory.distill.remote` (default false).
    - Extractive rollups whenever no LLM tier is configured or the configured one fails.
    - `memory_save` reinforces instead of duplicating.
    - The `simem memory distill [--all]` backfill.
  - **Measured:**
    - The labelled corpus (32 statements) passes at recall 1.00 and precision 1.00. It was written together with the rules, so treat that as an upper bound.
    - On this repo's real database, 34 of 38 checkpoints had never been distilled. The backfill distilled them with 0 provider calls: 10 new items and 88 restatements reinforced. A second `--all` pass added 0 new items.
    - Natural questions now inject those items.
  - **Deferred to after Phase 1:**
    - T0.5 app summaries (needs the Phase 1 sources).
    - Global/user scope with promote and demote (needs `global.db`).
    - Procedural memory from successful build/test commands (needs Phase 1 tool events; transcripts are only read as text today).

### Phase 3: built-in vector layer, primer, sanitization
The keyword fix already shipped in 1.0.6. Phase 3 adds:
- **3a vector layer:**
  - `src/memory/vec/` with a word-piece tokenizer, `safetensors` reader, static-embedding encoder, one-byte quantization, packed segment storage, and brute-force search
  - `vector_queue` plus background embedding, model download with checksum into `~/.simem/models/`
  - the combined ranking and gate, the `simem eval` calibration command, and an MMR de-duplication pass
  - the `EmbeddingClient` interface stays as-is, so Ollama and later models plug in the same way
- **3b injection:** `injections` dedupe, token budgets, SessionStart primer (also the handoff path), `sanitize()`.
- **Done when:**
  - the natural-language prompt from §1 item 3 retrieves memory #17 (passes since 1.0.6)
  - on the labelled set, reworded questions with no shared topic word (for example "why does the app open the wrong window" → the Cowork memory) reach ≥70% recall@3, and filler and off-topic prompts still inject nothing at precision ≥0.9
  - with the built-in model and no Ollama installed, it works fully offline after `init`; the encoder needs no native dependency; UserPromptSubmit p95 stays ≤150 ms including the query embedding
  - a model change re-embeds in the background without blocking hooks
  - trivial prompts inject nothing, and nothing is injected twice per session
  - the primer stays within budget and is byte-identical when inputs haven't changed
  - opening the Codex app after a Claude app session shows the Claude session's objective in the primer
  - the redaction suite passes

### Phase 4: code index
- Index tables, incremental indexing in the background, `code_search`/`code_read`/`repo_map`, updated instructions.
- **Done when:** a one-file edit re-indexes only that file; `code_search` puts the defining symbol in the top 3 for ≥80% of fixture queries; every tool output respects its budget.

### Phase 5: output compression and guards
- `simem exec`, `output_get`, PreToolUse rewrite (Claude app/CLI first, Codex after verification), L4/L5 guards, RTK detection.
- **Done when:** ≥60% median reduction on fixture logs with 100% of failure lines kept; identical exit codes; guards default to `suggest`; PreToolUse p95 ≤80 ms.

### Phase 6: visibility
- `memory_stats` and `simem_doctor` MCP tools, `simem stats`, the `simem dashboard` local UI, Stop `systemMessage` (where the app shows it).
- **Done when:** a user in the Claude app can ask "how many tokens did simem save this week?" and get exact plus labelled-estimate numbers; the dashboard can edit and forget memory; stats totals match a hand-summed fixture exactly.

### Phase 7: portability (optional)
- `memory export|import` (versioned JSONL, merged by content hash), `memory.syncDir` with optional encryption, so a new machine gets the same memory.

### Phase 8: distribution and docs
- Claude Code plugin (marketplace: hooks, MCP, slash commands), a Codex plugin if supported, an optional standalone binary (Node SEA, no Node toolchain), README rewrite (§11), CHANGELOG, `2.0.0`.

---

## 7. Testing strategy

- `node --test` with fixture homes `test/fixtures/homes/{claude-a,claude-b,codex}`. These cover app and CLI sessions, `codex_exec` and `Codex Desktop` originators, `usage`/`token_count` events, a Claude app `claude-code-sessions` metadata dir, and a Codex `memories_1.sqlite` fixture.
- Temporary git repos for identity: clone, worktree (Claude-style `.claude/worktrees/x`), rename, fork, `project link`.
- Install tests:
  - user-level writes are idempotent and byte-stable across reruns and upgrades
  - `--remove` restores the original files exactly
  - the launcher resolves when PATH has no `node`
- Migration from a mixai 1.x `.mixai/` snapshot, and back.
- Golden tests for `exec` filters, with an assertion that failure information is preserved.
- Retrieval regression: natural-language prompts against a fixture memory set (the §1 item 3 case has been covered since 1.0.6).
- Vector layer:
  - tokenizer parity with the reference Model2Vec output on a fixed sentence set
  - quantized vs float cosine agreement
  - segment storage round-trip
  - labelled eval set (exact, reworded, filler, off-topic) with recall and precision thresholds checked in CI
  - a latency benchmark for loading the model and embedding a query inside a fresh hook process
- Hook latency benchmarks: UserPromptSubmit p95 ≤150 ms, PreToolUse ≤80 ms, SessionStart ≤500 ms.
- Concurrency: the Claude app and the Codex app ingesting at the same time.
- **Manual app checklist per release:** fresh install from inside each app, new project, new worktree, account switch, Claude app → Codex app continuation, guard prompt behaviour, dashboard.

---

## 8. Migration and compatibility

- Semver major (2.0.0).
- The first 2.0 run migrates automatically, keeps a backup, and `simem migrate --to project` undoes it.
- Existing per-project integrations keep working. `init` offers to remove the old per-project blocks (`CLAUDE.local.md` import, `.worktreeinclude` lines, project hooks) once user-level hooks cover them, so nothing runs twice.
- 1.x MCP tool names and hook commands still work. `gateway.config.json` is mapped onto the new config with a warning.

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| App behaviour differs from the CLI, or changes between app releases (hook sources, `systemMessage`, user-scope MCP) | Verify in the app per surface, gate unverified ones behind flags, `doctor` shows live status, manual app checklist each release |
| GUI environment can't find Node or simem | Pinned absolute launcher, checked by `doctor`, rewritten on upgrade |
| Codex trust prompts on every change | Byte-stable dispatcher entries; behaviour comes from simem config |
| Hooks slow down the app UI | Latency budgets with benchmark tests, matchers limit which tools trigger hooks, heavy work detached |
| Undocumented app files (Claude session metadata, Codex memories SQLite) change shape | Read-only, version-guarded, fail-soft; they add to memory, nothing depends on them |
| Guards feel intrusive | Default `suggest`, a toggle per guard, never block twice for the same thing, visible in dashboard and doctor |
| A compression filter hides information the agent needed | Golden tests, `output_get`, unknown commands pass through untouched |
| A global store collecting transcripts from every account is a privacy concern | Local only, `0600` perms, redaction on ingest, `forget --project`/`--source`, optional encryption, nothing uploaded |
| Cloud/remote sessions (Claude Code on the web, Codex cloud tasks) never run local hooks | Documented limit; their local transcripts are ingested if they sync to the machine (verify) |
| Forks share a root commit and so share memory | `project unlink` |
| The embedding model download is unavailable (offline install, Hugging Face outage) | Keyword search works on its own; retry the download on the next `init`/`doctor`; publish a mirrored copy of the weights alongside the npm release |
| Static embeddings are weaker than transformer models, and English-only | Never used alone: the gate requires keyword support or a strict calibrated cutoff; `simem eval` reports recall/precision per model; Ollama `bge-m3` for other languages |
| DB growth and concurrent writes | head/tail outputs, retention, `VACUUM`; WAL, `busy_timeout`, idempotent upserts |

---

## 10. Decisions: recommended defaults (confirm or override)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Keep the name `simem` / `simem` | **Keep**; the tagline does the repositioning |
| D2 | `run` and provider routing | **Deprecate in 2.x, remove in 3.0** |
| D3 | Default storage | **Global `~/.simem`**, optional repo pin |
| D4 | Install scope | **User level, once per machine** (per account home); per-project `integrate` optional |
| D5 | `CLAUDE.local.md` `@BRIEF.md` import and `.worktreeinclude` | **Replace with the SessionStart primer**; offer cleanup on `init` |
| D6 | Default guard mode | **`suggest`** |
| D7 | Tree-sitter | **Optional dependency**, heuristic default |
| D8 | Remote LLM distillation | **Off by default** |
| D9 | RTK overlap | **Defer to RTK when detected** |
| D10 | Distribution | **npm first; Claude plugin and SEA binary in Phase 8** |
| D11 | Vector storage | **Inside `memory.db`** (packed one-byte-per-number segments, exact brute-force scan); `sqlite-vec` only above ~200k vectors |
| D12 | Default embedding model | **Built-in Model2Vec `potion-base-8M`**, downloaded on `init` with a pinned checksum; `potion-retrieval-32M` and Ollama (`bge-m3` for non-English prompts) as opt-in upgrades |

---

## 11. README rewrite outline (Phase 8)

1. **Hero:** "Spend fewer tokens. Never re-explain your project." Works in the **Claude Code app and the Codex app** (and their CLIs).
2. **Setup in 30 seconds, from inside your app:** the sentence to paste into Claude Code or Codex ("Install and set up simem: run `npm i -g simem && simem init`, then restart this app"). The plugin path once it exists. A terminal path for CLI users.
3. **The two problems it solves:** re-exploration and re-sent context burn tokens; memory is stuck in one app, one account, and one worktree.
4. **How it saves tokens:** L1–L10 in plain words, each with how it's measured, plus a real `memory_stats` answer from a chat (labelled as one person's numbers).
5. **Memory that follows the project:** a diagram (Claude app account A or B, Codex app, worktrees, clones → `~/.simem/projects/<id>`), and what survives.
6. **Using it day to day, just by asking:** "what did we decide about…", "remember that…", "how much did we save?", "open the simem dashboard". Then switching apps: open the other app and say "continue".
7. **Privacy and safety:** local only, no proxy, credentials never touched, redaction, zero provider tokens by default, easy uninstall.
8. **FAQ:**
   - Does it work in the desktop apps? Yes.
   - Do I need a terminal? Only for the one-time install, which the agent can run.
   - Does it proxy my API calls? No.
   - Does it need Ollama or a GPU to understand reworded questions? No; a small built-in model runs locally.
   - RTK?
   - How are savings measured?
9. **CLI reference**, **Handoff (extra)**, **Configuration**, **Development**, **License**.
