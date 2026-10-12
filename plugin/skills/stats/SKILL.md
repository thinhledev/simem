---
name: stats
description: Show real token usage from your coding agents and how much simem saved, for the last 7 days or a period you name (30d, 12h, all).
disable-model-invocation: true
argument-hint: "[7d | 30d | 12h | all]"
---

Show the user's token usage and simem's savings.

1. Pick the period from what the user typed after the command: a value like `30d`, `12h`, or an ISO date. Default to `7d`; for `all`, leave the period out.
2. Call the `memory_stats` tool with that period. Without the tool, run `simem stats --since <period>` (or `simem stats` for `all`).
3. Reply with a short summary: tokens your agents used, what simem kept out of the context, and the top sources of savings. Say which numbers are measured and which are estimates, as the output does. Don't paste the raw output.

If neither the tool nor the `simem` command exists, use the `simem-setup` skill.
