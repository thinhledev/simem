# Releasing simem

1. **Bump the version** in `package.json` (`npm version <x.y.z> --no-git-tag-version`), both plugin manifests (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`), `SERVER_INFO` in `src/memory/mcp-server.ts`, and the pinned install command in `plugin/skills/simem-setup/SKILL.md`. Add a `CHANGELOG.md` entry. Tests fail if the manifests or the skill's pin don't match `package.json`.
2. **Check:** `npm run build && npm test`, then `claude plugin validate --strict ./plugin && claude plugin validate --strict .`.
3. **Commit and push** to `master`. The Claude Code and Codex marketplaces (`thinhledev/simem`) and Anthropic's directory pick the plugin up from there.
4. **Publish to npm:** `npm publish` (runs the build, the dist check, and the tests first).
5. **Update the Homebrew tap** (needs the version on npm):

   ```bash
   git clone https://github.com/thinhledev/homebrew-simem ../homebrew-simem   # first time only
   scripts/homebrew-formula.sh <x.y.z> > ../homebrew-simem/Formula/simem.rb
   cd ../homebrew-simem && git commit -am "simem <x.y.z>" && git push
   ```

   Optional check: `brew update && brew upgrade simem && brew test simem`. When testing `simem init` in a sandbox, set `SIMEM_HOME_DISCOVERY=env` along with `SIMEM_HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME`; otherwise `init` also rewrites every real agent account on the machine to point at the sandbox.
6. **OpenAI plugin directory** (once listings are open): `scripts/package-plugin.sh`, then upload `build/plugin/simem-plugin-<x.y.z>.zip` to the existing draft. See `docs/plugin-submission.md`.
