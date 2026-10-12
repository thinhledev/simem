# simem plugin — Super Intelligence Memory

Teaches Claude Code and Codex to use [simem](https://github.com/thinhledev/simem): local project memory shared across every agent and account, plus tools that keep context small.

**Skills**
- `simem` — answers "what did we decide…", "remember…", "forget…", "how much did simem save?", and opens the memory dashboard.
- `simem-setup` — installs or repairs simem on this machine (`npm install -g @simem/cli && simem init`; needs Node.js 22.5+).

After installing the plugin, say **"set up simem"** in a new session. Hooks and tools come from `simem init`; the plugin only adds the skills, so nothing is registered twice. Everything stays on your machine — see [PRIVACY.md](https://github.com/thinhledev/simem/blob/master/PRIVACY.md).
