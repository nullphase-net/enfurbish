---
name: affirm
description: Affirm or show trust in the CLAUDE.md, .claude/rules/* files (project and user-global) and the files they @import. Use after reviewing changes flagged by the SessionStart hook. Invoke as /affirm.
---

# `/affirm` — affirm instruction files

`CLAUDE.md`, anything under `.claude/rules/`, and any files they pull in via Claude Code's `@import` syntax are loaded as Claude's system instructions. That holds for the project's own files and for the user-global ones under `~/.claude/`, and a malicious or accidental change to either can silently re-program Claude. `/affirm` is the explicit trust gate: bare `/affirm` shows you what's there; `/affirm -a` records SHA-256 hashes once you've reviewed; `/affirm --since <iso>` reports only what moved after a timestamp. The SessionStart hook compares stored hashes on every session start and warns on any mismatch.

## Procedure

Forward args to the CLI verbatim and relay output to the user. No confirmation prompts — the user types `-a` when they're ready to attest.

The CLI lives at `<skill-base-dir>/../../lib/cli.ts`.

### Bare `/affirm` — show details

```bash
bun run "<skill-base-dir>/../../lib/cli.ts"
```

Relay the output. This is read-only — nothing is recorded.

### `/affirm -a` (or `--apply`) — record hashes

```bash
bun run "<skill-base-dir>/../../lib/cli.ts" -a
```

Relay the output. The user invoking `-a` *is* the attestation; do not add a separate confirmation step.

### `/affirm --since <iso>` — what changed inside a window

```bash
bun run "<skill-base-dir>/../../lib/cli.ts" --since <iso>
```

Relay the output. Read-only. Lists only the tracked files whose mtime falls after `<iso>`, with their affirmation status and the subjects of any commits that touched them in that window; a file that is touched but still hash-matched is listed without a call to action. `continuity`'s `/wrap` calls this with the session's `session_start` so a change the user made themselves gets summarized at the end of the session that made it, rather than surfacing as a trust warning at the start of the next one.

### `/affirm --help`

```bash
bun run "<skill-base-dir>/../../lib/cli.ts" --help
```

Relay the output.

## What this skill does NOT do

- Read the contents of `CLAUDE.md` or rules files. That's the user's job — they're the one attesting.
- Modify any instruction file. Affirmation is hash-only.
- Affirm files nothing loads. Scope is `<cwd>/CLAUDE.md` + `<cwd>/.claude/rules/*`, the user-global `~/.claude/CLAUDE.md` + `~/.claude/rules/*`, and whatever any of them `@import` (followed two levels deep; an import pointing outside the project is hashed but flagged out-of-tree). Nested subdirectory CLAUDE.md files are still out of scope unless a tracked file imports one.
- Prompt the user "are you sure?". The flag is the attestation.

## Edge cases

- **No instruction files in cwd:** the CLI prints a single line and exits. Relay that and stop.
- **Unknown flag:** the CLI exits 2 with usage. Relay it.
- **Hash file at `~/.claude/affirm-hashes.json` is missing or unparseable:** the CLI treats it as empty and writes a fresh one on next `-a`. No action needed.
- **Un-affirming:** there is no revoke flag. Delete the file's line from `~/.claude/affirm-hashes.json` — that targets one file, which `-r` never did.
