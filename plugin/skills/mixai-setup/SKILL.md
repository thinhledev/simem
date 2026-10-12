---
name: mixai-setup
description: Install, update, or repair mixai (local memory for Claude Code and Codex) when the user asks to set it up or mixai tools are missing.
---

1. Check Node.js: `node --version` must be 22.5 or newer. If it is older, tell the user to update Node.js first and stop.
2. Install or update the CLI: `npm install -g mixai-cli@latest`.
3. Set it up for every agent account on this machine: `mixai init`. It installs hooks and MCP tools for Claude Code and Codex, imports this project's history, and downloads a small local embedding model (about 31 MB, no account needed). Add `--statusline` if the user wants savings in the Claude Code status line.
4. Run `mixai doctor` and report anything it flags.
5. Tell the user to restart the Claude Code and Codex apps (or start a new session) so the hooks and tools load. In the Codex app, they will be asked once to trust the new hooks.

Everything stays on this machine. To undo: `mixai init --remove`.
