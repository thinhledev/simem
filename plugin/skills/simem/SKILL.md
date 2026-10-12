---
name: simem
description: Use simem project memory when the user asks what was decided before, says "remember…" or "forget…", asks how many tokens simem saved, or wants the memory dashboard.
---

simem keeps this project's memory on this machine, shared by every agent app and account. Its tools are registered by `simem init` (MCP server `simem`).

- **"What did we decide about X?" / earlier work** → call the `recall` tool with the question; open a result with `memory_get <id>`. Without the tools, run `simem recall "<question>"`.
- **"Remember that…"** → `memory_save` with the fact as one self-contained sentence, `kind: "semantic"`, a `category` (decision, constraint, preference, fact, todo) and `importance` 7–9. Without the tools: `simem memory add "<fact>"`.
- **"Forget that…"** → find it with `recall`, then `memory_forget <id>`. Without the tools: `simem memory forget <id>`.
- **"How much did simem save?" / token usage** → `memory_stats` (or `simem stats`). Say which numbers are measured and which are estimates, as the output does.
- **"Show my memory" / dashboard** → run `simem dashboard --detach --open` and give the user the printed link.
- **Something seems off** → `simem_doctor` (or `simem doctor`) and relay what it says to fix.

If none of these tools or commands exist, use the `simem-setup` skill.
