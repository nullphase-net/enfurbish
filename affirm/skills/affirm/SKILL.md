---
name: affirm
description: Affirm, show, or revoke trust in the current project's CLAUDE.md and .claude/rules/* files. Use after reviewing changes flagged by the SessionStart hook. Invoke as /affirm.
---

# `/affirm` — affirm project instruction files

`CLAUDE.md` and anything under `.claude/rules/` are loaded as Claude's system instructions for this project. A malicious or accidental change can silently re-program Claude. `/affirm` is the explicit trust gate: bare `/affirm` shows you what's there; `/affirm -a` records SHA-256 hashes once you've reviewed; `/affirm -r` revokes. The SessionStart hook compares stored hashes on every session start and warns on any mismatch.

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

### `/affirm -r` (or `--revoke`) — drop affirmation

```bash
bun run "<skill-base-dir>/../../lib/cli.ts" -r
```

Relay the output.

### `/affirm --help`

```bash
bun run "<skill-base-dir>/../../lib/cli.ts" --help
```

Relay the output.

## What this skill does NOT do

- Read the contents of `CLAUDE.md` or rules files. That's the user's job — they're the one attesting.
- Modify any instruction file. Affirmation is hash-only.
- Touch files outside `<cwd>/CLAUDE.md` and `<cwd>/.claude/rules/*`. User-global `~/.claude/CLAUDE.md` is out of scope.
- Prompt the user "are you sure?". The flag is the attestation.

## Edge cases

- **No instruction files in cwd:** the CLI prints a single line and exits. Relay that and stop.
- **Unknown flag:** the CLI exits 2 with usage. Relay it.
- **`-a` and `-r` together:** the CLI exits 2 with a "mutually exclusive" error. Relay it.
- **Hash file at `~/.claude/affirm-hashes.json` is missing or unparseable:** the CLI treats it as empty and writes a fresh one on next `-a`. No action needed.
