---
name: wrap
description: Session-end retrospective. Writes a dated retro to ~/.claude/sessions/, appends to a cross-session tooling journal, and reconciles NEXT_SESSION.md so the next session can resume cleanly. Invoke as /wrap when ending a session, or /wrap -q for the local repo work only (NEXT_SESSION.md, no retro or journal).
---

# `/wrap` — session-end retrospective

Run at the end of a session. It captures what was learned, evaluates how the user's tooling stack performed, and stages the next session. The rules below were written from sessions that lost time without them; what was measured is in `<skill-base-dir>/rationale.md`. Read that when a rule looks wrong for the case in front of you, and before changing one.

## Modes

`/wrap` does everything. **Read `<skill-base-dir>/full.md` now**: it holds steps 2–4 (journal context, retro file, journal entry).

`/wrap -q` (or `--quick`) runs steps 1, 5, 6 and 7 only: the `NEXT_SESSION.md` lifecycle and the learnings list, the work that stays inside the repo. Steps 2–4 are skipped and `full.md` is not read. Anything the procedure routes to the retro goes into the final report instead. Use it when the session's value is a clean pointer rather than a retrospective.

## What you produce

1. Retro file at `~/.claude/sessions/YYYY-MM-DD-<cwd-slug>-<sessionid8>.md` *(full only)*
2. Journal entry appended to `~/.claude/tooling-journal.md` via `journal-append.ts` *(full only)*
3. `NEXT_SESSION.md` at the project root: written, left alone, or removed per step 5

## Procedure

Lib scripts live at the plugin root, two levels up from this file. `<skill-base-dir>` is the base directory Claude announced when it loaded this skill.

### 1. Run `scan.ts`

```bash
bun run "<skill-base-dir>/../../lib/scan.ts" --cwd "$(pwd)"
```

Parse the JSON. `ok: false` → note `degraded: true, reason: "..."` and proceed on self-reported stats from your own memory of the session.

- **Trailing stats.** Transcript writes are buffered. If `session_end` is more than ~60s behind wall-clock, say "stats trail by ~Ns" in the journal entry under the affected tool; otherwise the count silently undercounts.
- **`skills_invoked`** includes slash commands the user typed, so built-ins (`/clear`, `/compact`, `/config`) appear beside real skills. Skip them; they are not user-modifiable tooling.
- **`compaction_count`** is how many times the session compacted. A compaction does not truncate the jsonl, so `turn_count` covers the whole session either way; report it without a caveat.

### 2–4. Journal context, retro file, journal entry *(full only; in `full.md`)*

### 5. `NEXT_SESSION.md` lifecycle

A rolling pointer: items survive until the work is done, not until the next wrap fires. A wrap that did not touch what the prior pointer asked for must not erase those items.

**5.0 Find the file.** It is scoped per cwd and a project can hold several:

```bash
bun run "<skill-base-dir>/../../lib/handoffs.ts" --cwd "$(pwd)"
```

Reconcile the one in *this* cwd. A newer sibling is another session's pointer, not yours to merge; note it in the retro's Handoff section. Read the header line before the file:

- `newest N commits behind` / `+N commits`: the repo moved after the pointer was written, which is how a resolved item sits in it unmarked. 5.2 needs this number. A high count beside `stamp:assistant` is the normal shape of a session that ended without wrapping: untouched and out of date at the same time.
- `+Nh Nm after header`: the content moved after its own `**Last wrapped:**` line; trust the content over the header. `header Nh ahead of file` is the same comparison failing the other way: the header is wrong, and so is every window derived from it.
- `branches vs <base>:` the live branch and worktree layout. The new file need not copy it: a copied layout goes stale, and the next `--cwd` prints it again.
- `oversize:NNKB`: past 16 KB. Trim during the merge, dropping resolved threads and collapsing narrated ones. This is the last moment anything can.

**5.1 Ask who last wrote it.**

```bash
bun run "<skill-base-dir>/../../lib/handoffs.ts" --check "$(pwd)/NEXT_SESSION.md" "<session_start>"
```

Pass `session_start` from step 1. Line one is the verdict; line two says what to do with it. Follow line two. When it says preserve, the items you synthesized this session go to the retro's Follow-ups instead of the file. `absent` has no line two: there is nothing to merge, so 5.3 builds from this session alone, or 5.5 when it adds nothing.

**If the file says its open list lives in another tool, that tool owns the list.** The observable is a section standing where `## Open threads` would be, naming the tool and the commands that read it. Then 5.2 judges that tool's list and records every resolution and every new item there, 5.3 builds only the prose sections (no `## Open threads`, nothing copied in from the tool), and in 5.4 content in any prose section makes the file non-empty. Nothing here names a tool; the file does.

**5.2 Judge per item what this session resolved.** For each item under Open threads / Start here / Read first / Don't forget:

- The evidence is **`files_changed`** from the scan: what git says moved in this repo since `session_start` (paths from the repo root), commits plus work still dirty and modified inside the window. `files_edited` comes from Edit/Write records only, so it misses every heredoc and patch-script write; `files_edited_blind` marks it whenever it is empty or git saw a change it does not list. Never narrate "no files were edited" from either field. A path also in `files_changed_predated` came only from commits authored before the session, which a rebase, amend or cherry-pick re-dated into it: it is not evidence the session moved it. `--since` marks such commits `(authored before the header)`.
- Three limits on `files_changed`. It is git-derived, so an untracked *and* gitignored path never appears in it: a project that ignores its own `NEXT_SESSION.md` or scratch notes shows four rewrites as nothing. And it is repo-scoped, not session-scoped: a concurrent session, a subagent in another cwd, or the user in an editor all land in it, while a concurrent session on another branch lands in none of it. And it sees only this repo's tree: work installed on another host (a script copied to a server, a cron line, a remote config) never appears, so a low count is not evidence of a small session, and the pointer and retro name those changes explicitly. Corroborate against the retro or the transcript before writing "we changed"; otherwise write "changed during the session". Absence from the list is not evidence an item went untouched.
- If the pointer is older than this session, the work that closed an item may belong to a session that never wrapped. Ask git rather than reading files:

  ```bash
  bun run "<skill-base-dir>/../../lib/handoffs.ts" --since "$(pwd)/NEXT_SESSION.md"
  ```

  Commits and files landed after the pointer's own header, plus what is still uncommitted. `0 commits … still describes HEAD` is the all-clear; `window unknown` means it could not tell and you are back to reading.
- When in doubt, keep the item. Carrying a done item is cheap; dropping unfinished work is expensive.

**5.3 Build the new file.** Carry forward unaddressed items, add this session's, drop the addressed ones. The header is rendered, not typed, and it stamps the clock itself:

```bash
bun run "<skill-base-dir>/../../lib/handoffs.ts" --header "<cwd-slug>" "<sessionid8>" \
  "~/.claude/sessions/YYYY-MM-DD-<cwd-slug>-<sessionid8>.md"
```

Omit the retro path under `-q`; it renders `none (-q)`. Compose the body beneath it as prose; nothing parses it:

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

Four authoring rules:

- Say in words when an item is untested: "untested lead", "not yet run". No special prefix; `/next` reads items semantically.
- Every measured fact names the artifact that produced it, inline: a result file, a commit sha, a `file.py:symbol`.
- Verify any claim the item makes about the repo before writing it: counts, remaining budget, whether a proposed experiment is still feasible. A number this session measured an hour ago is not verified; re-run it now.
- An item that waits on a condition ("do X once Y lands") says whether Y has already happened as of writing. An unattended session obeys the condition as written.
- When the scan's `worktree.before_session` is above zero, uncommitted work has already outlived a session. Put `worktree.summary` under Don't forget, verbatim.

**5.4 Write or remove.** Any items → write. Empty after the merge → `rm <cwd>/NEXT_SESSION.md` and note "removed (all resolved)" in the Handoff section.

**5.5** No file existed and no new items → do nothing.

**5.6 Stamp last, write path only,** after every edit to the file is final. Re-stamping unchanged content is a no-op, so mid-session reconciles should stamp too. A stamp that changes moves the header's timestamp with it, so the next report does not read `+Nm after header` for your own reconcile.

```bash
bun run "<skill-base-dir>/../../lib/handoffs.ts" --stamp "$(pwd)/NEXT_SESSION.md"
```

**5.7 Gitignore suggestion, write path only:**

```bash
SUGGEST=$(bun run "<skill-base-dir>/../../lib/gitignore.ts" --suggest-line NEXT_SESSION.md --for-write)
```

On every other path leave `SUGGEST` empty. Note in the Handoff section which items carried forward, which resolved, and which were added, so the user can audit the judgment.

### 6. Route learnings

A learning that should change what a future session does goes in the retro's Learnings (under `-q`, in the final report), and the user decides what to change. It is not an open thread: `NEXT_SESSION.md` carries this project's unfinished work. Write what happened and what would have prevented it. Name the cheapest place the fix could live, and stop at the first that closes the loop:

1. **The environment.** An install, alias, config or script change that makes the failure impossible.
2. **A hook.** The mistake is a command or file shape a program can detect. Prose does not stop a habit.
3. **A scoped rule.** It applies to one file type, tool, host or project, and something can see that condition.
4. **An always-on instruction.** It applies to every session in every project. Name the existing instruction it would replace, or one that no longer earns its place.

Most sessions have none.

**Then re-check affirmation.** If the `affirm` plugin is installed:

```
/affirm --since <session_start> [<dir>...]
```

Add each other repo this session edited or committed to as a `<dir>`: the check reads the cwd's instruction files, so a sibling repo's edited `CLAUDE.md` otherwise reads as a clean window. Invoke the skill, not a path; affirm resolves its own lib. Files untouched inside the window produce a single `0 of N` line and nothing to do. When it names a NEW or CHANGED file, put the summary line in the retro rather than asking; sessions end with nobody at the keyboard. Not installed → skip it; the `Affirm:` line of the final report says `not installed` and nothing else does.

### 7. Final report

```
/wrap complete:
  Retro:          <path>
  Journal:        ~/.claude/tooling-journal.md (appended)
  NEXT_SESSION:   <written|preserved|removed|absent>
  Learnings:      <none|N, in the retro>
  Affirm:         <clean|N changed, re-affirm|not installed>
  Worktree:       <worktree.summary from the scan, verbatim|not a repo>
$SUGGEST
```

Under `-q` drop the Retro and Journal lines, put the 5.7 note (carried, resolved, added) on a `Handoff:` line after `NEXT_SESSION:`, since there is no retro to hold it, list any learnings after the block, and head it `/wrap -q complete (local only):`. An empty `$SUGGEST` collapses; no trailing blank lines.

## Policy

- The wrap writes the retro, the journal entry and `NEXT_SESSION.md`, autonomously, and changes nothing else. Ask only on genuine ambiguity.
- Best-effort. `scan.ts` failing → self-reported stats and "stats unavailable" in the journal entry. One failed write does not block the rest.
