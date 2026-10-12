# simem plugin — Super Intelligence Memory

Teaches Claude Code and Codex to use [simem](https://github.com/thinhledev/simem): local project memory shared across every agent and account, plus tools that keep context small.

**Skills**
- `simem` — answers "what did we decide…", "remember…", "forget…", "how much did simem save?", and opens the memory dashboard.
- `simem-setup` — installs or repairs simem on this machine, asking before each step: `npm install -g @simem/cli` (Node.js 22.5+) or Homebrew (`brew tap thinhledev/simem`, `brew trust --formula thinhledev/simem/simem`, `brew install simem`; no Node.js needed), then `simem init`.

**Shortcuts** (run only when you type them; Claude Code doesn't load them into the context until then)
- `/simem:stats [7d | 30d | all]` — token usage and what simem saved. In Codex: `$simem:stats`.
- `/simem:dashboard` — opens the private memory dashboard on this machine. In Codex: `$simem:dashboard`.

After installing the plugin, say **"set up simem"** in a new session. Hooks and tools come from `simem init`; the plugin only adds the skills, so nothing is registered twice. Everything stays on your machine — see [PRIVACY.md](https://github.com/thinhledev/simem/blob/master/PRIVACY.md).
