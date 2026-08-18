---
name: wrap
description: Session-end retrospective. Produces a dated retro file, appends to a cross-session tooling journal, and reconciles NEXT_SESSION.md so the next session can resume cleanly. Invoke as /wrap when ending a session, or /wrap -q for the local repo work only (NEXT_SESSION.md + CLAUDE.md, no retro or journal).
---

# `/wrap` — Session-end retrospective

Run this at the end of a session. It captures what was learned, evaluates how the user's tooling stack performed, and stages the next session.

## Modes

`/wrap` with no args does everything below.

`/wrap -q` (or `--quick`) does **only the local repo work** — the `NEXT_SESSION.md` lifecycle (step 5) and any CLAUDE.md routing (step 6). It skips the retro file (step 3) and the journal append (step 4), the two writes that land outside the repo. Step 1 still runs: `scan.ts` is a read, and step 5 needs `session_start` and `files_edited` from it. Step 2 is skipped along with the journal.

Use it when the session's value is a clean pointer, not a retrospective — a short arc, a mid-day handoff, a session whose tooling story is identical to the last one you journaled.

## What you produce

1. **Dated retro file** at `~/.claude/sessions/YYYY-MM-DD-<cwd-slug>-<sessionid8>.md` — the canonical record. *(skipped under `-q`)*
2. **Tooling journal entry** appended to `~/.claude/tooling-journal.md` via `journal-append.ts`. *(skipped under `-q`)*
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

**`skills_invoked` note:** it captures both `Skill` tool calls and slash commands typed by the user, so built-in commands (`/clear`, `/compact`, `/config`) appear alongside real skills. Skip the built-ins per step 4's rubric — they aren't user-modifiable tooling.

**Compaction note:** If `compaction_count > 0`, the current jsonl is a post-compaction segment and `turn_count` counts ONLY turns after the last compaction. State this explicitly in the retro (`Turns: N user / N model (since last of K compactions)`) so future readers don't take the counts at face value.

### 2. Pull cross-session journal context  *(skip under `-q`)*

For each tool key in `tools` and `mcp` from scan output, pull what prior wraps said about it:

```bash
bun run "<skill-base-dir>/../../lib/journal-append.ts" --journal ~/.claude/tooling-journal.md --recent <toolname>
```

This gives the last few verdicts on each tool used this session, so you can spot patterns ("same 0% hit rate as prior 5 sessions") instead of evaluating cold. It matches tool names loosely and reports how many spellings it found — headings are free text and they drift, so `### Hook: SessionStart (continuity)` and `### continuity scan.ts` both answer to `continuity`. Don't substitute a `grep`: measured against this journal, `^### continuity` reaches 109 of 134 sections.

Then read the standing backlog once:

```bash
bun run "<skill-base-dir>/../../lib/journal-append.ts" --journal ~/.claude/tooling-journal.md --actions
```

Newest first, with the qualifier the original wrap attached. An action carrying `(recurring, unmoved)` or `(10th repetition)` is the one to act on or explicitly retire — not to log an eleventh time.

If `~/.claude/tooling-journal.md` does not exist, both commands report zero — `journal-append.ts` creates it with a header on the first append.

### 3. Synthesize the retro file  *(skip under `-q`)*

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

### 4. Append journal entry  *(skip under `-q`)*

Hand the entry to `journal-append.ts` as JSON. It renders the on-disk shape — you supply the judgment, not the punctuation:

```bash
cat <<'JOURNAL' | bun run "<skill-base-dir>/../../lib/journal-append.ts" --journal ~/.claude/tooling-journal.md
{
  "timestamp": "2026-05-12T17:00:00-04:00",
  "slug": "<cwd-slug>",
  "session": "abc12345",
  "arc": "one-liner",
  "tools": [
    {
      "name": "<your-mcp>",
      "usage": "6 calls, 2 errors",
      "verdict": "hurt",
      "notes": ["Bullet observation.", "Another one."],
      "action": "concrete improvement idea"
    }
  ]
}
JOURNAL
```

`usage`, `notes` and `action` are all optional; omit `action` when there genuinely isn't one rather than writing "none". Raw markdown on stdin still appends verbatim, for a retroactive or hand-written entry — but the JSON form is the default, because a format the model reassembles from memory is a format that drifts, and this one measurably did.

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

`action` is the highest-value field in the journal. Aim for it. If an entry has no concrete observation AND no action, you have not justified its existence — skip the tool.

Empty stdin is a no-op — the script exits cleanly without touching the journal.

### 5. NEXT_SESSION.md lifecycle

`NEXT_SESSION.md` is a rolling pointer: items survive until the work is actually done, not until the next wrap fires. A wrap that didn't touch what the prior pointer asked for must NOT erase those items.

**Procedure:** (under `-q` there is no retro file, so anything this procedure routes to the retro goes into the final report instead)

0. **Find the file.** `NEXT_SESSION.md` is scoped per cwd and a project can hold several:

   ```bash
   bun run "<skill-base-dir>/../../lib/handoffs.ts" --cwd "$(pwd)"
   ```

   Reconcile the one in *this* cwd. If the report shows a newer sibling, note it in the retro's Handoff section — that's another session's pointer and not yours to merge.

1. **Ask who last wrote it, then decide whether to preserve.**

   ```bash
   bun run "<skill-base-dir>/../../lib/handoffs.ts" --check "$(pwd)/NEXT_SESSION.md"
   ```

   - `assistant` — content still matches the stamp a wrap wrote. Nothing has touched it since. Proceed to the per-item merge.
   - `edited` — someone wrote to it after the last stamp. **Leave it alone.** Don't clobber their notes; new next-steps you synthesized go into the retro's "Follow-ups staged" section.
   - `unstamped` — written before this mechanism existed, or by hand. Fall back to the mtime test: mtime ≥ `session_start` ⇒ treat as user-edited and preserve.

   The stamp exists because mtime was wrong in both directions. Every wrap writes the file *after* `session_start`, and assistant edits made through Bash (`cp`, a python heredoc) never enter `files_edited` either — so both the original heuristic and its first proposed fix classified the assistant's own work as the user's. A content hash the wrap stamps in is the only signal that survives whichever tool did the writing.

2. **Read it and judge per-item what this session resolved.** For each item under "Open threads" / "Start here" / "Read first" / "Don't forget":
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

6. **(Write path only) Stamp the file you just wrote.** This is what makes the next wrap's `--check` meaningful — an unstamped file is indistinguishable from a hand-written one:

   ```bash
   bun run "<skill-base-dir>/../../lib/handoffs.ts" --stamp "$(pwd)/NEXT_SESSION.md"
   ```

   Stamp last, after every edit to the file is final. Re-stamping unchanged content is a no-op, so mid-session reconciles can stamp too — and should, so a session that dies before its wrap still leaves an honestly-labelled pointer.

7. **(Write path only) Capture a gitignore suggestion for the final report.** This step runs ONLY when this invocation actually wrote `NEXT_SESSION.md` — not when it was preserved-user-edited (step 1), removed (step 4 → empty), or absent (step 5). On the write path:

   ```bash
   SUGGEST=$(bun run "<skill-base-dir>/../../lib/gitignore.ts" --suggest-line NEXT_SESSION.md --for-write)
   ```

   On all other paths, leave `SUGGEST` empty (`SUGGEST=""`) or skip the call entirely. Calling without `--for-write` also returns empty — both forms are safe no-ops.

Note in the retro's Handoff section which items carried forward, which were resolved, and which were added — so the user can audit your judgment.

**The header is rendered, not typed.** `handoffs.ts` parses `**Last wrapped:**` back out of this file, so the same file writes it:

```bash
bun run "<skill-base-dir>/../../lib/handoffs.ts" --header "<cwd-slug>" "<ISO ts>" "<sessionid8>" \
  "~/.claude/sessions/YYYY-MM-DD-<cwd-slug>-<sessionid8>.md"
```

Omit the retro path under `-q`; it renders `none (-q)`. Compose the body beneath it — nothing parses the body, so it stays prose:

```markdown
## Start here
One sentence on the most important thing to pick up.

## Open threads
- [ ] Concrete action — file:line if applicable

## Read first
- `path` — why it matters

## Don't forget
- Anything fragile or hard to reconstruct.
```

**Three authoring rules, each written from a session that lost time without them:**

- **Say plainly when an item is untested.** A hunch stated with two supporting statistics is indistinguishable from a result. If you did not measure it this session, the item must say so in words — "untested lead", "not yet run". No special prefix: `/next` reads these items semantically, so a magic token would be a parse contract with nothing behind it.
- **Every measured fact names the artifact that produced it, inline** — a result file, a commit sha, a `file.py:symbol`. "Zero detections after BH" costs the next session an archaeology dig to tell "already done" from "to do"; "zero detections after BH (`results/h10b-corpus-101-K199.json`, `09fd257`)" does not.
- **Verify any claim the item makes about the repo before writing it.** Counts, remaining budget, whether a proposed experiment is still feasible — usually three lines of arithmetic. A pointer that proposes an infeasible plan costs the next session real time and, if believed, spends a scarce resource on it.

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

Under `-q`, drop the Retro and Journal lines entirely and head the report `/wrap -q complete (local only):` — a line reading "skipped" is noise, but a report that silently looks like a full wrap is a lie.

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
