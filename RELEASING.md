# Releasing

Each plugin (`continuity/`, `affirm/`) ships independently. There is no top-level version; per-plugin tags are the source of truth.

## What goes where

- `<plugin>/.claude-plugin/plugin.json` — the `version` field. Bump it in the same commit as the change.
- Annotated tag `<plugin>-vX.Y.Z` at the ship-point on `main`: the merge commit if the work landed via merge (e.g., from a worktree), otherwise the bump commit directly. The tag is what Claude Code's plugin marketplace consumes.
- `~/.claude/plugins/cache/enfurbish/<plugin>/<version>/` — the installed plugin tree on this machine. `~/.claude/plugins/installed_plugins.json` records the version and commit sha.

## Versioning

Semver-ish:

- **patch** (`0.2.0` → `0.2.1`) — bug fix, hint or matcher tweak, no surface change for callers
- **minor** (`0.2.x` → `0.3.0`) — new command, new hook, new optional flag
- **major** (`0.x` → `1.0`) — breaking change for an existing command, hook contract, or storage format

If a change touches both `continuity/` and `affirm/`, bump them independently with their own commits and tags. They install independently and the marketplace tracks them by name.

## Steps

1. Make the change. Add or update tests. `bun test` green.
2. Bump `<plugin>/.claude-plugin/plugin.json` `version`.
3. Commit. Message: `<plugin>: <short summary>` (matches the existing log shape — see `git log --oneline`).
4. Tag the ship-point on `main` (merge commit if work landed via merge, bump commit otherwise). With HEAD at that commit: `git tag -a <plugin>-vX.Y.Z -m "<plugin> X.Y.Z — <one-line>"`.
5. Push branch + tag: `git push && git push origin <plugin>-vX.Y.Z`.
6. On any machine running the plugin, pull the new version through Claude Code's plugin update flow (the marketplace caches by commit sha, so a `git pull` of the cache directory or a `/plugin update <name>@enfurbish` is required — it is NOT picked up automatically until then).

## Where to look if it doesn't update

- `~/.claude/plugins/installed_plugins.json` — what Claude Code thinks is installed. Compare `gitCommitSha` to the tag's commit.
- `~/.claude/plugins/cache/enfurbish/<plugin>/<version>/` — the on-disk plugin. If the path's version segment doesn't match the new version, the update didn't run.
- `~/.claude/plugins/marketplaces/enfurbish/` — the marketplace clone. `git log -1` here shows the commit Claude Code last fetched.

## Settings-watcher caveat

Hook changes (`hooks.json`) installed while a Claude Code session is already running won't fire in that session — Claude Code reads the hook config once at session start. Open a fresh `claude` process to verify.
