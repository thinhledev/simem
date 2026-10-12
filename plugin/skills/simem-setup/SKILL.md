---
name: simem-setup
description: Install, update, or repair simem (local memory for Claude Code and Codex) when the user asks to set it up or simem tools are missing.
---

1. Check Node.js: `node --version`.
   - **22.5 or newer:** install or update with `npm install -g simem@latest`, then run `simem init`.
   - **Missing or older (macOS or Linux):** install the standalone binary, which needs no Node.js and runs `simem init` itself: `curl -fsSL https://github.com/thinhledev/simem/releases/latest/download/install.sh | sh`. Ask the user before running it.
2. `simem init` installs hooks and MCP tools for Claude Code and Codex, imports this project's history, and downloads a small local embedding model (about 31 MB, no account needed). Add `--statusline` if the user wants savings in the Claude Code status line.
3. Run `simem doctor` and report anything it flags.
4. Tell the user to restart the Claude Code and Codex apps (or start a new session) so the hooks and tools load. In the Codex app, they will be asked once to trust the new hooks.

Everything stays on this machine. To undo: `simem init --remove`.
