# Privacy

simem (Super Intelligence Memory) runs entirely on your computer.

Published by Thinh Le ([github.com/thinhledev](https://github.com/thinhledev)).

- **No data leaves your machine.** simem has no server, no account, no analytics, and no telemetry. Memory, indexes, and settings live in `~/.simem` (or your project's `.simem/` folder if you choose in-repo storage).
- **What it reads:** your coding agents' local session transcripts and memory files (for example `~/.claude`, `~/.codex`, `~/.cursor`) and the files of projects you use it in, to build local memory and a local code index.
- **What it writes:** its own data under `~/.simem`, and — when you run `simem init` or `simem integrate` — clearly marked entries in your agents' configuration files, which `simem init --remove` / `simem integrate --remove` take out again.
- **Secrets:** API keys, tokens, passwords, and private keys found in transcripts or command output are redacted before anything is stored or shown.
- **Network use:** only when you ask for it — downloading the embedding model during `simem init` (from Hugging Face, checksum-verified), the optional `memory.syncDir` folder you choose, an optional local Ollama, and, only if you turn on `memory.distill.remote`, your own coding agent's CLI.
- **The plugins** for Claude Code and Codex contain instructions (skills) only; they collect nothing.

Delete `~/.simem` to remove all of simem's data. Questions: https://github.com/thinhledev/simem/issues
