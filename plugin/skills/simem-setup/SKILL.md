---
name: simem-setup
description: Install, update, or repair simem (local project memory for coding agents) when the user asks to set it up or simem tools are missing.
---

Set up simem only when the user asked for it, and get their explicit go-ahead before each step that changes their machine. Never install anything, change configuration, or download files on your own initiative.

1. **Check what is there (read-only).** Run `node --version` and `simem --version`.
   - Node.js missing or older than 22.5: tell the user simem needs Node.js 22.5 or newer from https://nodejs.org (or their usual version manager), and stop. Don't install Node.js yourself.
2. **Install the CLI, after asking.** Tell the user you are about to run `npm install -g @simem/cli@2.0.1`: it installs the open-source simem command (source: https://github.com/thinhledev/simem, package: https://www.npmjs.com/package/@simem/cli). Run it only after they say yes. Skip this step if `simem --version` already printed 2.0.1.
3. **Preview the setup (read-only).** Run `simem init --check`. It writes nothing; it lists every file `simem init` would add or change, such as hook and tool entries in the user's agent settings.
4. **Apply it, after asking.** Show the user that list and explain that `simem init` will:
   - add those hook and tool entries, so memory works in every agent session;
   - import this project's past agent sessions into `~/.simem` on this machine;
   - download a small embedding model (about 31 MB, MIT-licensed) unless they prefer `simem init --no-model`.

   Run `simem init` (or `simem init --no-model`) only after they say yes. Add `--statusline` only if they ask for savings in the status line.
5. **Verify.** Run `simem doctor` and report anything it flags.
6. **Finish.** Tell the user to restart their agent apps or start a new session so the hooks and tools load. Their app may ask them to review and trust the new hooks; let them decide.

Everything stays on this machine; nothing is uploaded. To undo: `simem init --remove`, then `npm uninstall -g @simem/cli`.
