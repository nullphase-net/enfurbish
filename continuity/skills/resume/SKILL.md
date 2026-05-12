---
name: resume
description: Manually read NEXT_SESSION.md in the current cwd and brief the user on what's pending. Mirror of the SessionStart hook for cases where the hook didn't fire or the user wants to re-consult mid-session.
---

# `/resume` — manual NEXT_SESSION read

Use when the user wants to pick up where the last session left off and either the SessionStart hook didn't surface anything, was disabled, or the user wants to re-consult later in the session.

## Procedure

1. **Read `NEXT_SESSION.md` in the current cwd.**
   - If absent: tell the user nothing is staged and stop. Don't synthesize a follow-up plan from thin air.
2. **Summarize "Start here" and "Open threads" in 2-3 sentences.**
   - Mention the wrap timestamp from the file header so the user knows how stale it is.
3. **Ask the user which thread to pick up.**
   - Don't start work yet. Wait for them to choose.

## What this skill does NOT do

- Write or modify any file. `/resume` is read-only by design.
- Touch the tooling journal or retro files.
- Scan subdirectories for sibling `NEXT_SESSION.md` files. That's the SessionStart hook's job at session start; `/resume` is for the local file only.

## Edge cases

- If `NEXT_SESSION.md` exists but is empty or has no `## Open threads` items, treat it as "stale stub" — tell the user it exists but holds nothing actionable.
- If the file is over ~16KB, summarize aggressively rather than reading the whole thing back. Long handoff files are a smell; flag it.
