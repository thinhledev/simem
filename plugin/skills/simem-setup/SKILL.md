---
name: simem-setup
description: Install, update, or repair simem (local project memory for coding agents) when the user asks to set it up or simem tools are missing.
---

Set up simem only when the user asked for it, and get their explicit go-ahead before each step that changes their machine. Never install anything, change configuration, or download files on your own initiative.

1. **Check what is there (read-only).** Run `simem --version`, `node --version`, and `brew --version`. If simem already prints 2.0.2 or newer, go to step 3.
2. **Install the CLI, after asking.** Pick one route, tell the user the exact command and what it installs (the open-source simem command: https://github.com/thinhledev/simem, https://www.npmjs.com/package/@simem/cli), and run it only after they say yes:
   - Node.js 22.5 or newer: `npm install -g @simem/cli@2.0.2`.
   - Otherwise, with Homebrew (macOS or Linux): `brew install thinhledev/simem/simem`. It brings its own Node.js, so the user doesn't need one.
   - Neither: tell the user simem needs Node.js 22.5 or newer (https://nodejs.org) or Homebrew (https://brew.sh), and stop. Don't install those yourself.
3. **Preview the setup (read-only).** Run `simem init --check`. It writes nothing; it lists every file `simem init` would add or change, such as hook and tool entries in the user's agent settings.
4. **Apply it, after asking.** Show the user that list and explain that `simem init` will:
   - add those hook and tool entries, so memory works in every agent session;
   - import this project's past agent sessions into `~/.simem` on this machine;
   - download a small embedding model (about 31 MB, MIT-licensed) unless they prefer `simem init --no-model`.

   Run `simem init` (or `simem init --no-model`) only after they say yes. Add `--statusline` only if they ask for savings in the status line.
5. **Verify.** Run `simem doctor` and report anything it flags.
6. **Finish.** Tell the user to restart their agent apps or start a new session so the hooks and tools load. Their app may ask them to review and trust the new hooks; let them decide.

Everything stays on this machine; nothing is uploaded. To undo: `simem init --remove`, then `npm uninstall -g @simem/cli` (or `brew uninstall simem`).
