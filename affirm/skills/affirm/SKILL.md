---
name: affirm
description: Affirm, show, or revoke trust in the current project's CLAUDE.md and .claude/rules/* files. Use after reviewing changes flagged by the SessionStart hook. Invoke as /affirm.
---

# `/affirm` — affirm project instruction files

`CLAUDE.md` and anything under `.claude/rules/` get loaded as Claude's system instructions for this project. A malicious or accidental change to either can silently re-program Claude. `/affirm` is the explicit trust gate: the user reviews the files, then runs this skill to record their SHA-256 hashes. The SessionStart hook checks those hashes on every session start and warns on any mismatch.

## Procedure

The CLI lives at `<skill-base-dir>/../../lib/cli.ts`.

### Default — affirm everything in the current cwd

1. **Show the user what's about to be affirmed first.** Don't just run the affirm — they're attesting that they've reviewed the content, so show them.
   ```bash
   bun run "<skill-base-dir>/../../lib/cli.ts" --show
   ```
2. **Ask the user to confirm.** If anything is flagged `NEW` or `CHANGED`, point them at the specific files to read first. Don't proceed until they say yes.
3. **Affirm:**
   ```bash
   bun run "<skill-base-dir>/../../lib/cli.ts"
   ```
4. Report the affirmed file list back to the user.

### `--show` — just report status

Run the `--show` subcommand and relay output verbatim. No follow-up action.

### `--revoke` — drop affirmation for this project

Used when the user wants to force the warning to fire again next session (e.g., they're testing the guard, or they want to force themselves to re-review).

1. Confirm with the user that they intend to revoke.
2. Run `bun run "<skill-base-dir>/../../lib/cli.ts" --revoke`.
3. Report the revoked file list.

## What this skill does NOT do

- Read the contents of `CLAUDE.md` or rules files. That's the user's job — they're the one attesting.
- Modify any instruction file. Affirmation is hash-only.
- Touch files outside `<cwd>/CLAUDE.md` and `<cwd>/.claude/rules/*`. User-global `~/.claude/CLAUDE.md` is out of scope.

## Edge cases

- **No instruction files in cwd:** the CLI prints a single line and exits. Relay that and stop.
- **User passes a flag we don't recognize:** the CLI exits 2 with usage. Show the user the usage and ask what they meant.
- **Hash file at `~/.claude/affirm-hashes.json` is missing or unparseable:** the CLI treats it as empty and writes a fresh one on next affirm. No action needed.
