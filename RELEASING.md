# Releasing

Each plugin (`continuity/`, `affirm/`, `pastiche/`) ships independently. There is no top-level version. Each plugin installs from its own tag, and `.claude-plugin/marketplace.json` on `main` names which tag.

## What goes where

- `<plugin>/.claude-plugin/plugin.json` — the `version` field. Bump it in the same commit as the change.
- Annotated tag `<plugin>-vX.Y.Z` on the **last commit of the release** — the final state you intend people to install. That is usually the bump commit itself (19 of the 30 tags to date), and is later when docs or fixes land after the bump, or when one commit ships several plugins. A merge commit gets the tag when the merge is what lands the release — 3 of `main`'s 4 merges are tagged — but that falls out of the rule rather than being a second rule; do not reach for "merge or bump" as the question. The tagged tree is what installs; see below.
- One commit may carry tags for several plugins. `e472d03` carries `affirm-v0.6.2` and `continuity-v0.9.1`; `792f538` and `cfc597a` carry three each.
- `.claude-plugin/marketplace.json` — each plugin's `source` pins its tag in `ref`. Moving that pin is the release.
- `~/.claude/plugins/cache/enfurbish/<plugin>/<version>/` — the installed plugin tree on this machine. `~/.claude/plugins/installed_plugins.json` records the version and commit sha.

## What installs

Each entry in `.claude-plugin/marketplace.json` is a `git-subdir` source pinned to that plugin's tag:

```json
"source": { "source": "git-subdir", "url": "https://github.com/nullphase-net/enfurbish.git", "path": "pastiche", "ref": "pastiche-v0.10.1" }
```

The `url` is the full HTTPS URL, never the `owner/repo` shorthand. Claude Code expands the shorthand to `git@github.com:owner/repo.git` unless `CLAUDE_CODE_PLUGIN_PREFER_HTTPS` or `CLAUDE_CODE_REMOTE` is set, and a `git-subdir` clone has no HTTPS fallback. On a machine with no GitHub SSH key the update then fails with "Could not read from remote repository". Measured 2026-09-30 on a work machine, then read in Claude Code 2.1.285, where the shorthand expands to SSH and only those two variables switch it to HTTPS.

Claude Code reads the catalog from `main`, because the marketplace was added with no `ref`. It fetches each plugin's directory at the tag the catalog names. So `main` can carry unreleased work: nothing reaches an install until its pin moves.

An update also installs only when the `version` in the pinned `plugin.json` differs from the installed one: "`claude plugin update` and background auto-update compute the version again and skip the plugin when it matches what `installed_plugins.json` records" ([plugin loading reference](https://code.claude.com/docs/en/plugins/loading#versions-and-updates)). A pin moved to a tag with an unchanged version installs nothing.

The remote must hold the tag before it holds a pin that names it. A pin to a missing tag leaves every install and update of that plugin with nothing to fetch. `git push --atomic` sends both or neither.

Until 2026-09-30 the sources were plain paths (`./pastiche`). A path source cannot pin a ref, so an update copied the tip of `main`: `claude plugin update` installed pastiche 0.10.0 from `1afb4e5`, one continuity-only commit past `pastiche-v0.10.0` (`e324aaf`). A first install took whatever `main` held. The pinned source was tested the same day in isolated config dirs. A fresh install took the tagged commit, with a tree identical to the tag's. An existing path-source install moved to the pinned source on `claude plugin update`.

## Versioning

Semver-ish:

- **patch** (`0.2.0` → `0.2.1`) — bug fix, hint or matcher tweak, no surface change for callers
- **minor** (`0.2.x` → `0.3.0`) — new command, new hook, new optional flag
- **major** (`0.x` → `1.0`) — breaking change for an existing command, hook contract, or storage format

If a change touches more than one plugin, version each one on its own and give each its own tag — they install independently and the marketplace tracks them by name. The bumps may share a commit; `e472d03` bumps `affirm` and `continuity` together and carries both tags.

## Steps

1. Make the change. Add or update tests. `bun test` green.
2. Bump `<plugin>/.claude-plugin/plugin.json` `version`.
3. Commit. Message: `<plugin> X.Y.Z: <short summary>` (matches the existing log shape — see `git log --oneline`).
4. Tag the last commit of the release on `main` — the bump commit unless something landed after it. `git tag -a <plugin>-vX.Y.Z <commit> -m "<plugin> X.Y.Z — <one-line>"`; pass the sha explicitly rather than relying on where HEAD happens to sit.
5. Pin it: set that plugin's `ref` in `.claude-plugin/marketplace.json` to the new tag and commit. `claude plugin validate .` checks the file.
6. Push branch and tag together: `git push --atomic origin main <plugin>-vX.Y.Z`.
7. Install it from GitHub the way a user with no GitHub SSH key would. The config dir is a throwaway, and SSH is made keyless:

   ```bash
   p=<plugin>; t=$p-vX.Y.Z
   d=$(mktemp -d) && (
     export CLAUDE_CONFIG_DIR="$d" GIT_TERMINAL_PROMPT=0 \
       GIT_SSH_COMMAND='ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -i /dev/null -o BatchMode=yes'
     claude plugin marketplace add nullphase-net/enfurbish && claude plugin install "$p@enfurbish"
   ) && jq -r --arg k "$p@enfurbish" '.plugins[$k][0] | "\(.version) \(.gitCommitSha)"' "$d/plugins/installed_plugins.json"
   echo "$(git show "$t:$p/.claude-plugin/plugin.json" | jq -r .version) $(git rev-parse "$t^{commit}")"
   rm -rf "$d"
   ```

   The two printed lines must match. A clone error naming `git@github.com` means a `url` in `marketplace.json` is not the HTTPS form (see "What installs"). A clone error naming the tag means the push did not carry it. A version or sha that differs means the pin names a different tag, or the tagged commit was not bumped. `claude plugin validate .` passes in all three cases.
8. On any machine running the plugin, run `claude plugin update <name>@enfurbish` (or `/plugin update`), then `/reload-plugins`. The installed copy is a snapshot under `cache/`, not a clone, and auto-update is off for a third-party marketplace unless someone turned it on, so nothing arrives until then.

Until step 8 runs, each plugin's `SessionStart` hook says so in any session whose cwd is this checkout (or the plugin's own directory in it): `continuity 0.11.0 is running, but this checkout has 0.12.0. …` on both channels. It compares the running copy's `plugin.json` against the checkout's, so it also fires after a checkout moves back to an older commit, and while a bump on `main` waits for its release.

## Where to look if it doesn't update

- `<name> is already at the latest version (<version>).` — the pinned `plugin.json` has the version already installed. Either the pin still names the old tag, or the tagged commit was not bumped.
- `~/.claude/plugins/installed_plugins.json` — what Claude Code thinks is installed. Compare `gitCommitSha` to `git rev-parse <plugin>-vX.Y.Z^{commit}`.
- `~/.claude/plugins/cache/enfurbish/<plugin>/<version>/` — the on-disk plugin. If the path's version segment doesn't match the new version, the update didn't run.
- `~/.claude/plugins/marketplaces/enfurbish/` — the marketplace clone. `git log -1` here shows the catalog commit Claude Code last fetched, and its `marketplace.json` shows the pins it read.

## Settings-watcher caveat

Hook changes (`hooks.json`) installed while a Claude Code session is already running won't fire in that session — Claude Code reads the hook config once at session start. Open a fresh `claude` process to verify.
