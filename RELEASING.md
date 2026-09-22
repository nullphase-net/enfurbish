# Releasing

Each plugin (`continuity/`, `affirm/`, `pastiche/`) ships independently. There is no top-level version; per-plugin tags are the source of truth.

## What goes where

- `<plugin>/.claude-plugin/plugin.json` — the `version` field. Bump it in the same commit as the change.
- Annotated tag `<plugin>-vX.Y.Z` on the **last commit of the release** — the final state you intend people to install. That is usually the bump commit itself (19 of the 30 tags to date), and is later when docs or fixes land after the bump, or when one commit ships several plugins. A merge commit gets the tag when the merge is what lands the release — 3 of `main`'s 4 merges are tagged — but that falls out of the rule rather than being a second rule; do not reach for "merge or bump" as the question. The tag is what Claude Code's plugin marketplace consumes.
- One commit may carry tags for several plugins. `e472d03` carries `affirm-v0.6.2` and `continuity-v0.9.1`; `792f538` and `cfc597a` carry three each.
- `~/.claude/plugins/cache/enfurbish/<plugin>/<version>/` — the installed plugin tree on this machine. `~/.claude/plugins/installed_plugins.json` records the version and commit sha.

## Versioning

Semver-ish:

- **patch** (`0.2.0` → `0.2.1`) — bug fix, hint or matcher tweak, no surface change for callers
- **minor** (`0.2.x` → `0.3.0`) — new command, new hook, new optional flag
- **major** (`0.x` → `1.0`) — breaking change for an existing command, hook contract, or storage format

If a change touches more than one plugin, version each one on its own and give each its own tag — they install independently and the marketplace tracks them by name. The bumps may share a commit; `e472d03` bumps `affirm` and `continuity` together and carries both tags.

## Steps

1. Make the change. Add or update tests. `bun test` green.
2. Bump `<plugin>/.claude-plugin/plugin.json` `version`.
3. Commit. Message: `<plugin>: <short summary>` (matches the existing log shape — see `git log --oneline`).
4. Tag the last commit of the release on `main` — the bump commit unless something landed after it. `git tag -a <plugin>-vX.Y.Z <commit> -m "<plugin> X.Y.Z — <one-line>"`; pass the sha explicitly rather than relying on where HEAD happens to sit.
5. Push branch + tag: `git push && git push origin <plugin>-vX.Y.Z`.
6. On any machine running the plugin, pull the new version through Claude Code's plugin update flow (the marketplace caches by commit sha, so a `git pull` of the cache directory or a `/plugin update <name>@enfurbish` is required — it is NOT picked up automatically until then).

## Where to look if it doesn't update

- `~/.claude/plugins/installed_plugins.json` — what Claude Code thinks is installed. Compare `gitCommitSha` to the tag's commit.
- `~/.claude/plugins/cache/enfurbish/<plugin>/<version>/` — the on-disk plugin. If the path's version segment doesn't match the new version, the update didn't run.
- `~/.claude/plugins/marketplaces/enfurbish/` — the marketplace clone. `git log -1` here shows the commit Claude Code last fetched.

## Settings-watcher caveat

Hook changes (`hooks.json`) installed while a Claude Code session is already running won't fire in that session — Claude Code reads the hook config once at session start. Open a fresh `claude` process to verify.
