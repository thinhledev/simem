# Publishing the simem plugin

simem ships one plugin folder (`plugin/`) with two manifests: `.claude-plugin/plugin.json` for Claude Code and `.codex-plugin/plugin.json` for Codex. Both use the same skills (`simem`, `simem-setup`) and icon.

## 1. Self-hosted marketplaces (live as soon as `master` is pushed)

This repository is a marketplace for both apps. No form or review is involved.

| App | Marketplace file | Users run |
|---|---|---|
| Claude Code | `.claude-plugin/marketplace.json` | `/plugin marketplace add thinhledev/simem`, then `/plugin install simem@simem` |
| Codex | `.agents/plugins/marketplace.json` | `codex plugin marketplace add thinhledev/simem`, then `codex plugin add simem@simem` |

To release a new plugin version, bump `version` in both manifests (a test keeps them equal to `package.json`) and push. Users get it with `claude plugin update simem@simem` or `codex plugin marketplace upgrade`.

Before every release, run:

```bash
claude plugin validate --strict ./plugin && claude plugin validate --strict .
```

## 2. Anthropic's directory (claude.ai, Cowork, and Claude Code via account sync)

- **Where:** the developer portal at https://claude.ai/directory/manage. The steps are in [Submit a plugin](https://claude.com/docs/plugins/submit#submit-a-plugin).
- **Who can submit:** a paid claude.ai plan (Pro or Max from your own account; on Team or Enterprise, an Owner).
- **Repository:** `https://github.com/thinhledev/simem`. The plugin is in `plugin/`, and the marketplace entry is `.claude-plugin/marketplace.json`.
- **Already in `plugin.json`:** `displayName`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `icon` (`./assets/simem.png`, 512×512), `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`.
- **Note for review:** the skills tell the agent to run the local `simem` CLI. They work fully in Claude Code. On claude.ai and Cowork, where no local CLI is available, the `simem-setup` skill explains what to install.
- Anthropic's official `claude-plugins-official` marketplace doesn't take submissions; the directory is the public route.

## 3. OpenAI's plugin directory (ChatGPT and Codex)

- **Where:** https://platform.openai.com/plugins, then **Upload new or existing plugin**. The guide is [Submit plugins](https://developers.openai.com/plugins/deploy/submission).
- **Who can submit:** an organization owner, or a member with **Apps Management Write**. Publishing under your name or company also requires individual or business verification in the organization settings.
- **Package:** run `scripts/package-plugin.sh`, which writes `build/plugin/simem-plugin-<version>.zip`.
- **Skills-only:** no MCP review cases and no demo recording are required.

### Listing fields (from `.codex-plugin/plugin.json`)

| Field | Value |
|---|---|
| Name | `simem` |
| Display name (≤30) | `simem` |
| Short description (≤30) | `Super Intelligence Memory` |
| Category | Developer Tools |
| Developer | Thinh Le |
| Website | https://github.com/thinhledev/simem |
| Support | https://github.com/thinhledev/simem/issues |
| Privacy policy | https://github.com/thinhledev/simem/blob/master/PRIVACY.md |
| Terms of service | https://github.com/thinhledev/simem/blob/master/TERMS.md |
| Icon | `plugin/assets/simem.png` (512×512) |

**Long description:** use `interface.longDescription` from `plugin/.codex-plugin/plugin.json`.

**Release notes (2.0.0):** First public release under the name simem (Super Intelligence Memory). It adds two skills. One answers questions from local project memory, saves and forgets facts, reports token savings, and opens the memory dashboard. The other installs or repairs the simem CLI. All data stays on the user's machine.

### Test cases (optional for skills-only; useful if reviewers ask)

Positive:
1. "Set up simem on this machine." → `simem-setup` checks the Node.js version, installs `simem` (or the standalone binary after asking), runs `simem init` and `simem doctor`, and tells the user to restart.
2. "What did we decide about the database?" → `simem`: the `recall` tool or `simem recall`, quoting the matching memory.
3. "Remember that we deploy only from CI." → `memory_save` (or `simem memory add`) with category `decision`.
4. "How many tokens did simem save this week?" → `memory_stats` (or `simem stats --since 7d`), separating measured figures from estimates.
5. "Open my memory dashboard." → runs `simem dashboard --detach --open` and returns the local link.

Negative:
1. "Write a haiku about autumn." → no simem action.
2. "Delete all my files." → no simem action; this is outside the plugin's scope.
3. "Send my project memory to my coworker's email." → declines. simem is local-only and has no sharing feature; the user can export a bundle with `simem memory export` themselves.
