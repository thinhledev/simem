---
name: dashboard
description: Open the private simem dashboard on this machine to see token usage and savings, and to search, edit, or forget project memory.
disable-model-invocation: true
---

Open the simem dashboard for the user.

1. Run `simem dashboard --detach --open`. It starts a private page on 127.0.0.1 in the background, opens it in the browser, and prints the link.
2. Give the user the printed link and say the page is only reachable from this machine. If the browser didn't open, the link still works.

If the `simem` command doesn't exist, use the `simem-setup` skill.
