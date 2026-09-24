# Why each `/wrap` rule exists

The evidence behind the rules in `SKILL.md` and `full.md`, grouped by step. Nothing here is procedure. Read it when a rule looks wrong for the case in front of you, and before changing one: each was written from a session that lost time without it, and a rule that reads as excessive is usually one whose failure you have not met yet.

## Step 1: scan.ts

- **Counts are diagnosed from the records, never from the last wrap's prior.** The sign of the user-turn error has flipped once already: a 5× undercount for six consecutive wraps, then an overcount once that was fixed, because a loaded SKILL.md enters the transcript as a user record beside the slash command that loaded it, so one action counted twice.
- **Compaction does not truncate the transcript.** This rule once said it did, and every compacted session's retro carried `(since last of K compactions)` on a count that already covered the whole session. Measured 2026-09-24 on both compacted transcripts on this machine (Claude Code 2.1.268, 2.1.274): 12 and 1 user turns before the boundary, in the same file. The summary a compaction injects is a user record flagged `isCompactSummary`, and it no longer counts as a turn.
- **`files_edited_blind` covers a partial list, not only an empty one.** One Edit beside heredoc writes listed 5 of 7 changed paths and read as complete.

## Step 2: journal context

- **Loose matching, no grep.** Over ~130 wraps of prose-owned format, `grep '^- Action:'` reached 143 of 241 action lines and `^### continuity` reached 109 of 134 sections, across 35 spellings of one heading. Free text a model composes drifts; the reader has to survive that, and the writer has to stop causing it.
- **The stale block has a job attached.** Recency alone made the backlog write-only. At 20 rows against 336 actions an item left the view about four days after it was written and was never shown again, which is how 132 sessions produced 5 closes. The 336 rows were 276 distinct ideas, so this was not duplication that grouping would fix; it was 93% of the list being invisible.
- **Retiring is a write.** For months the skill said an unmoved action was "the one to act on or explicitly retire" while offering no way to retire one, so none ever was: 312 actions in which closed and open were indistinguishable, one of them re-logged eight consecutive times with all eight inside the default 20-row view. `closed` lines exist because an instruction with no mechanism behind it measurably does nothing.
- **A close names an `#id`.** The first 20 closes were prose, and a reader paired every one with the right action, but nothing took a closed action out of the view: on 2026-09-24 all five stale rows had been closed once or twice each, and the block had shown the same five since 2026-09-20. Text matching could not have saved them. The closes paraphrase ("superpowers:writing-plans could call out…" retires "skill could explicitly call out…"), so a prefix rule misses and a fuzzier one hides open work nobody retired.

## Step 4: journal entry

- **JSON in, rendered out.** The prose-owned format produced the 35 spellings above and 98 action lines the documented grep could not see. A format string in a prompt is reassembled from memory every session, and nothing catches a drifted field order.

## Step 5: NEXT_SESSION.md

- **Read the header before the file.** A pointer accurately reported as 2h52m old had 14 commits behind it (2026-08-18); the session briefed from it lost its first turns to work already committed. Sessions end without a wrap routinely, so the procedure treats a stale pointer as the normal case.
- **`oversize`.** One pointer reached 70 KB, +10 KB of it in a single wrap. `/next` can only summarize around it; the merge is the last moment anything can trim it.
- **The stamp.** mtime was wrong in both directions. Every wrap writes after `session_start`, and assistant edits made through Bash (`cp`, a python heredoc) never enter `files_edited`, so both the original heuristic and its first proposed fix classified the assistant's own work as the user's. A content hash the wrap stamps in is the only signal that survives whichever tool did the writing.
- **`:during` needs your transcript.** Followed literally on 2026-09-14, "edited means the user's, preserve it" would have discarded an entire session's handoff work, none of it the user's: a mid-session reconcile had rewritten the file without re-stamping, and the model doing that reconcile had no reason to have loaded this skill.
- **`:prior` merges.** Measured 2026-09-18: preserving a dead session's pointer would have sent the next session to launch a duplicate of a scarce, billable GPU instance. Unlike the `:during` cases there are no user notes at risk, and the pointer is stale by exactly the work that session never got to log.
- **`assistant` is not an all-clear.** On 2026-09-08 a pointer stamped `assistant`, edited by nobody, described a repo nine commits in the past, and three of its six threads were dead. The stamp detects hand-edits; only `--since` detects staleness.
- **`files_changed`, not `files_edited`.** Eight consecutive wraps logged `files_edited []` against 6, 2, 14 and 11 real file changes, because under auto mode every write is a heredoc or a patch script.
- **The gitignored blind spot.** Ignore rules do not apply to tracked files (one listed in `.gitignore` but committed with `git add -f` still reports as modified), so the blind spot is precisely untracked-and-ignored, which is what these artifacts usually are. It only ever looked right in a project whose `.handoff-backup/` happened to be committed, which is that repo's convention and nothing the skill guarantees.
- **Repo-scoped, not session-scoped.** A session reported 19 dirty files, one of them a version bump left over from a prior session that this one never touched. The dirty half is mtime-filtered against `session_start` for the same reason: `git status` is not time-bounded.
- **The header is rendered.** A timestamp composed from memory wrote UTC clock-time wearing a CDT offset, 5h fast, into a pointer, and every `--since` window derived from it under-reported silently until a human noticed. The clock is deterministic, so the clock supplies it.
- **Say "untested" in words.** A hunch stated with two supporting statistics is indistinguishable from a result. A magic prefix would be a parse contract with nothing parsing it; `/next` reads items semantically.
- **Name the artifact.** "Zero detections after BH" costs the next session an archaeology dig to tell "already done" from "to do"; "zero detections after BH (`results/h10b-corpus-101-K199.json`, `09fd257`)" does not.
- **Verify repo claims.** A pointer that proposes an infeasible plan costs the next session real time and, if believed, spends a scarce resource on it. Usually three lines of arithmetic.
- **A delegated open list.** Measured 2026-09-21 with dry-run agents on a handoff that named its store: five of five runs of the previous skill text already honoured the file's own section, so the paragraph is the contract written down, not a behaviour change. The line that changed behaviour is in `/next`, for the case with no file at all.

## Step 6: affirm

- **At wrap time, not session start.** A CHANGED warning at the next session start about a file the user edited themselves is pure alert fatigue; by construction they already know. Across eight wraps the mtime window separated 6 positives from 2 negatives cleanly. It reports rather than asks because two of those eight sessions ended with nobody at the keyboard to answer a prompt.
- **Invoke the skill, not a path.** Three sessions lost turns to a hardcoded lib path. Affirm resolves its own.

## `-q`

- A short arc, a mid-day handoff, or a session whose tooling story is identical to the last one journaled has a clean pointer as its whole value. The two writes outside the repo were pure cost there, and the mode exists so the pointer still gets reconciled instead of skipped along with them.
