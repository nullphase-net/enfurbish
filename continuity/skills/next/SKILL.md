---
name: next
description: Manually read the project's newest NEXT_SESSION.md and brief the user on what's pending. Mirror of the SessionStart hook for cases where the hook didn't fire or the user wants to re-consult mid-session.
---

# `/next` — manual NEXT_SESSION read

Use when the user wants to pick up where the last session left off and either the SessionStart hook didn't surface anything, was disabled, or the user wants to re-consult later in the session.

## Procedure

1. **Find the handoffs.** The skill's lib scripts live at the plugin root, two levels up from this SKILL.md. Use the base directory Claude told you about for this skill:

   ```bash
   bun run "<skill-base-dir>/../../lib/handoffs.ts" --cwd "$(pwd)"
   ```

   The report lists every `NEXT_SESSION.md` under the project root, newest first, `*` on the newest and `[local]` on the one in the current cwd. Read the header line before anything else — it names the count and, when the local pointer is not the newest, how far behind it is.

2. **Read the pointer the report marks `*`.** Not the local one, unless they are the same file. Cwd varies between sessions in one project — an autonomous run in a subdirectory writes its own handoff — and reading the cwd-local file because it was closest is what cost a session real turns on 2026-08-18.
   - If the local file is not the newest, say so in one line before summarizing: which file you read, and how much staler the local one is.
   - If there are no handoffs at all: tell the user nothing is staged and stop. Don't synthesize a follow-up plan from thin air.

3. **Summarize "Start here" and "Open threads" in 2-3 sentences.**
   - Mention the wrap timestamp from the file header so the user knows how stale it is.
   - An item the last session flagged as untested is a hypothesis, not a finding. Present it as one — never as a settled result.

4. **Ask the user which thread to pick up.**
   - Don't start work yet. Wait for them to choose.

## What this skill does NOT do

- Write or modify any file. `/next` is read-only by design.
- Touch the tooling journal or retro files.

## Edge cases

- `+Nh after header` on a line means the file moved after its own `**Last wrapped:**` header was written — mid-session reconciles the header does not describe. Trust the content over the header timestamp.
- `stamp:edited` means the file no longer matches the stamp `/wrap` wrote — someone hand-edited it since. Worth mentioning; hand-written items are usually the most load-bearing ones. `stamp:assistant` means it is exactly as the last wrap left it.
- If `NEXT_SESSION.md` exists but is empty or has no `## Open threads` items, treat it as "stale stub" — tell the user it exists but holds nothing actionable.
- If the file is over ~16KB, summarize aggressively rather than reading the whole thing back. Long handoff files are a smell; flag it. Read the "Don't forget" section in full regardless — that section is where hard-won gotchas live, and a 2026-08-16 session spent two days re-deriving a fact staged there.
