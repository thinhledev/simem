---
name: mixai
description: Use mixai project memory when the user asks what was decided before, says "remember…" or "forget…", asks how many tokens mixai saved, or wants the memory dashboard.
---

mixai keeps this project's memory on this machine, shared by every agent app and account. Its tools are registered by `mixai init` (MCP server `mixai`).

- **"What did we decide about X?" / earlier work** → call the `recall` tool with the question; open a result with `memory_get <id>`. Without the tools, run `mixai recall "<question>"`.
- **"Remember that…"** → `memory_save` with the fact as one self-contained sentence, `kind: "semantic"`, a `category` (decision, constraint, preference, fact, todo) and `importance` 7–9. Without the tools: `mixai memory add "<fact>"`.
- **"Forget that…"** → find it with `recall`, then `memory_forget <id>`. Without the tools: `mixai memory forget <id>`.
- **"How much did mixai save?" / token usage** → `memory_stats` (or `mixai stats`). Say which numbers are measured and which are estimates, as the output does.
- **"Show my memory" / dashboard** → run `mixai dashboard --detach --open` and give the user the printed link.
- **Something seems off** → `mixai_doctor` (or `mixai doctor`) and relay what it says to fix.

If none of these tools or commands exist, use the `mixai-setup` skill.
