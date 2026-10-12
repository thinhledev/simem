---
name: mixai-setup
description: Install, update, or repair mixai (local memory for Claude Code and Codex) when the user asks to set it up or mixai tools are missing.
---

1. Check Node.js: `node --version`.
   - **22.5 or newer:** install or update with `npm install -g mixai-cli@latest`, then run `mixai init`.
   - **Missing or older (macOS or Linux):** install the standalone binary, which needs no Node.js and runs `mixai init` itself: `curl -fsSL https://github.com/thinhledev/mixai/releases/latest/download/install.sh | sh`. Ask the user before running it.
2. `mixai init` installs hooks and MCP tools for Claude Code and Codex, imports this project's history, and downloads a small local embedding model (about 31 MB, no account needed). Add `--statusline` if the user wants savings in the Claude Code status line.
3. Run `mixai doctor` and report anything it flags.
4. Tell the user to restart the Claude Code and Codex apps (or start a new session) so the hooks and tools load. In the Codex app, they will be asked once to trust the new hooks.

Everything stays on this machine. To undo: `mixai init --remove`.
