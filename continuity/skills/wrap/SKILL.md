---
name: wrap
description: Session-end retrospective. Produces a dated retro file, appends to a cross-session tooling journal, and reconciles NEXT_SESSION.md so the next session can resume cleanly. Invoke as /wrap when ending a session.
---

# `/wrap` — Session-end retrospective

Run this at the end of a session. It captures what was learned, evaluates how the user's tooling stack performed, and stages the next session.

## What you produce

1. **Dated retro file** at `~/.claude/sessions/YYYY-MM-DD-<cwd-slug>-<sessionid8>.md` — the canonical record.
2. **Tooling journal entry** appended to `~/.claude/tooling-journal.md` via `journal-append.ts`.
3. **`NEXT_SESSION.md`** at the project root — written, left alone, or removed per the lifecycle rules below.
4. **(Conditional) CLAUDE.md edits** — user-level or project-level, only with explicit user confirmation.

## Procedure

### 1. Run `scan.ts`

The skill's lib scripts live at the plugin root, two levels up from this SKILL.md. Use the base directory Claude told you about for this skill:

```bash
bun run "<skill-base-dir>/../../lib/scan.ts" --cwd "$(pwd)"
```

Parse the JSON. If `ok: false`, note `degraded: true, reason: "..."` and proceed with self-reported stats from your own session memory.

**Buffering note:** Claude Code may buffer transcript writes, so the last few events (including the `/wrap` call itself) may not appear in the count. If `session_end` from `scan.ts` is more than ~60s behind the current wall-clock time, mention "stats trail by ~Ns" in the journal entry under the relevant tool — otherwise the count silently undercounts.

**Compaction note:** If `compaction_count > 0`, the current jsonl is a post-compaction segment and `turn_count` counts ONLY turns after the last compaction. State this explicitly in the retro (`Turns: N user / N model (since last of K compactions)`) so future readers don't take the counts at face value.

### 2. Pull cross-session journal context

For each tool key in `tools` and `mcp` from scan output, grep recent journal blocks:

```bash
grep -A 15 "^### <toolname>" ~/.claude/tooling-journal.md 2>/dev/null | tail -n 100
```

This gives the last few verdicts on each tool used this session, so you can spot patterns ("same 0% hit rate as prior 5 sessions") instead of evaluating cold.

If `~/.claude/tooling-journal.md` does not exist, skip — `journal-append.ts` will create it with a header on the first append.

### 3. Synthesize the retro file

Compose the file using this template; fill in real content from your session and from `scan.ts`.

```markdown
# Session retro — YYYY-MM-DD — <cwd-slug> — <sessionid8>

**Cwd:** <cwd>
**Duration:** Nm  •  **Turns:** N user / N model
**Transcript:** <transcript_path>

## What happened
2-4 sentences. Narrative arc: goal, what was tried, where it landed. Not a tool-call recap.

## Learnings
- Claim, with the evidence/reasoning that supports it.
- Focus on novel/unexpected. Skip restating known facts.

## Tooling assessment
*Only user-modifiable tooling: installed skills, MCP servers, hooks, project-specific tools. Built-in Claude Code tools (Read/Write/Edit/Bash/etc.) are not journaled — they're not under user control. See step 4.*

### <tool name>
- Used: N times. Verdict: helped / hurt / neutral.
- Specifics: what worked, what friction.

## Follow-ups staged
- [ ] Concrete next step.

## Handoff
- NEXT_SESSION.md: written / preserved / removed (all resolved) / absent
- CLAUDE.md: none / user-confirmed / project-confirmed
```

Write the retro to `~/.claude/sessions/YYYY-MM-DD-<cwd-slug>-<sessionid8>.md`. Use `mkdir -p ~/.claude/sessions` if needed.

### 4. Append journal entry

Build an entry per this format:

```markdown
## <ISO timestamp>  •  <cwd-slug>  •  <sessionid8>

**Session arc:** one-liner.

### <tool>  •  <count summary>  •  verdict: <helped|hurt|neutral>
- Bullet observations.
- Action: concrete improvement idea (only when one exists).
```

**Verdict rubric:**
- `helped` — output the session actually used.
- `hurt` — wasted time/tokens, produced wrong info, or required correction.
- `neutral` — ran without error and without observable signal either way.

**What to include — only what the user can change.** The journal exists to improve the user's tooling stack. Built-in Claude Code tools (Read, Write, Edit, MultiEdit, Bash, Grep, Glob, Skill, Agent/Task, AskUserQuestion, WebSearch, WebFetch, NotebookEdit, etc.) are NOT under user control — skip them all. Don't generate entries for them even if they had errors.

Evaluate only:
- **Skills** the user has installed (`Skill` invocations — content lives in the user's plugin/skills tree).
- **MCP servers** (anything `mcp__*`).
- **Hooks** (from `hooks` in scan output).
- **Project-specific tools** the user has written.

`Action:` lines are the highest-value content in the journal. Aim for them. If an entry has no concrete observation AND no action, you have not justified its existence — skip the tool.

Pipe the entry into `journal-append.ts`:

```bash
cat <<'JOURNAL' | bun run "<skill-base-dir>/../../lib/journal-append.ts" --journal ~/.claude/tooling-journal.md
## 2026-05-12T17:00:00-04:00  •  <slug>  •  abc12345

**Session arc:** ...

### <your-mcp>  •  ...  •  verdict: hurt
- ...
- Action: ...
JOURNAL
```

Empty stdin is a no-op — the script will exit cleanly without touching the journal.

### 5. NEXT_SESSION.md lifecycle

`NEXT_SESSION.md` is a rolling pointer: items survive until the work is actually done, not until the next wrap fires. A wrap that didn't touch what the prior pointer asked for must NOT erase those items.

**Procedure:**

1. **If the file's mtime ≥ `session_start`, the user edited it mid-session — leave it alone.** Don't clobber their notes. Any new next-steps you synthesized go into the retro's "Follow-ups staged" section.

2. **Otherwise, if the file exists, read it and judge per-item what this session resolved.** For each item under "Open threads" / "Start here" / "Read first" / "Don't forget":
   - Was the item addressed? Evidence: the file was edited (check `files_edited` from scan), the work appears in commits this session, the retro's "What happened" covers it.
   - When in doubt, KEEP the item. False-negatives (carrying a done item) are cheap; false-positives (dropping unfinished work) are expensive.

3. **Build the new file:**
   - Carry forward unaddressed items from the prior file.
   - Add new items synthesized from this session's work.
   - Drop addressed items.
   - Update "Last wrapped" / "Retro" headers to point at this session.

4. **Decide write vs remove:**
   - If the merged file would have any items → write it.
   - If the merged file would be empty (everything resolved, nothing new) → remove with `rm <cwd>/NEXT_SESSION.md` and note "removed (all resolved)" in the retro's Handoff section.

5. **If no file existed and you have no new items, do nothing.**

6. **(Write path only) Capture a gitignore suggestion for the final report.** This step runs ONLY when this invocation actually wrote `NEXT_SESSION.md` — not when it was preserved-user-edited (step 1), removed (step 4 → empty), or absent (step 5). On the write path:

   ```bash
   SUGGEST=$(bun run "<skill-base-dir>/../../lib/gitignore.ts" --suggest-line NEXT_SESSION.md --for-write)
   ```

   On all other paths, leave `SUGGEST` empty (`SUGGEST=""`) or skip the call entirely. Calling without `--for-write` also returns empty — both forms are safe no-ops.

Note in the retro's Handoff section which items carried forward, which were resolved, and which were added — so the user can audit your judgment.

When writing, use this format:

```markdown
# Next session — <cwd-slug>

**Last wrapped:** <ISO ts> (session <sessionid8>)
**Retro:** ~/.claude/sessions/YYYY-MM-DD-<cwd-slug>-<sessionid8>.md

## Start here
One sentence on the most important thing to pick up.

## Open threads
- [ ] Concrete action — file:line if applicable

## Read first
- `path` — why it matters

## Don't forget
- Anything fragile or hard to reconstruct.
```

### 6. Routing rubric for learnings

For each learning, pick the lowest-cost destination that closes the loop. Default to retro-only.

| Destination | When | Confirm? |
|---|---|---|
| User CLAUDE.md (`~/.claude/CLAUDE.md`) | Cross-project rule that should load every session. High bar — permanent context cost. | **Yes** |
| Project CLAUDE.md (`<cwd>/CLAUDE.md`) | Project-specific durable convention. Field-report-driven rules with rationale. | **Yes** |
| Retro file only | One-off observation; ephemeral. | No |

Promote to CLAUDE.md only if it should shape every future session — confirm before writing because CLAUDE.md is durable and visible.

### 7. Final report

After everything is written, output a short summary to the user:

```
/wrap complete:
  Retro:          <path>
  Journal:        ~/.claude/tooling-journal.md (appended)
  NEXT_SESSION:   <written|preserved|removed|absent>
  CLAUDE.md:      <none|user-confirmed|project-confirmed>
$SUGGEST
```

(If `$SUGGEST` is empty, the line collapses — no trailing blank lines in the report.)

## Confirmation policy

Only **CLAUDE.md edits** require explicit user confirmation. The skill autonomously writes/removes its own artifacts (retro file, journal entry, `NEXT_SESSION.md`). CLAUDE.md is special because it's user-authored, often committed to git, and durable across sessions.

Otherwise: ask only when synthesis hits genuine ambiguity. Lean on Claude to do what's needed.

## Degraded modes

The wrap is best-effort. One failure does not abort the rest.

- `scan.ts` returns `ok: false` → proceed with self-reported stats; note "stats unavailable" in journal entry.
- Per-write failures isolated — one failed file write does not block the rest.

## Out of scope

- Working-tree cleanup (deleting scratch files, stripping debug prints).
- Git operations (commits, branch hygiene).
- `.gitignore` management for `NEXT_SESSION.md` — user decides per project.
- Any memory system beyond the retro file, the journal, and `NEXT_SESSION.md`.
