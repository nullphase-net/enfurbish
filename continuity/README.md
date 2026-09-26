# continuity

Intentional session continuity for Claude Code.

A plugin that closes the loop between Claude Code sessions: `/wrap` ends a session by producing a retro, a tooling-stack verdict, and a handoff note. A `SessionStart` hook names the handoff at the start of the next session without loading it. `/next` is what actually opens it.

## Commands

### `/wrap`

Run at the end of a session. Produces three files:

- **Retro** — `~/.claude/sessions/YYYY-MM-DD-<cwd-slug>-<sid8>.md`. Dated record of the session: what happened, what was learned, how the tooling performed.
- **Tooling-journal entry** — appended to `~/.claude/tooling-journal.md`. Cross-session verdicts on the parts of your stack you can change.
- **Handoff** — `<cwd>/NEXT_SESSION.md`. What the next session should pick up. Reconciled with any existing file: items survive until they're actually done, not until the next wrap fires.

`/wrap -q` (or `--quick`) does only the local repo work — `NEXT_SESSION.md` and any CLAUDE.md routing. No retro, no journal entry. For a session whose value is a clean pointer rather than a retrospective.

The skill is three files. `SKILL.md` is the spine every wrap loads; `full.md` holds the retro and journal steps and is read only on a full wrap, so `-q` never pays for it; `rationale.md` holds the measured evidence behind each rule and is read only when a rule looks wrong for the case at hand.

### `/next`

Read-only. Lists every `NEXT_SESSION.md` under the project root, reads the newest, and summarizes "Start here" + "Open threads". Reading the *newest* rather than the cwd-local one is deliberate: cwd varies between sessions in one project, and an autonomous run in a subdirectory writes its own handoff. Use when the SessionStart hook didn't fire or you want to re-consult mid-session.

The listing is a CLI you can run yourself:

```bash
bun run lib/handoffs.ts --cwd "$(pwd)"          # every handoff, newest first
bun run lib/handoffs.ts --check ./NEXT_SESSION.md   # assistant | edited | unstamped, and what to do about it
bun run lib/handoffs.ts --check ./NEXT_SESSION.md 2026-09-18T12:00:00Z  # ...:during | ...:prior
bun run lib/handoffs.ts --since ./NEXT_SESSION.md   # what landed after its header
```

```
2 handoffs · root /Users/me/projects/myapp · local is 1d 10h staler than newest · newest 7 commits behind
* sub/NEXT_SESSION.md      8h 39m ago wrapped 2026-08-18T09:00:00-05:00  stamp:edited  +1h 54m after header  +7 commits
  NEXT_SESSION.md [local]  1d 18h ago wrapped 2026-08-16T22:45:00-05:00  oversize:21KB
```

The header line is the load-bearing one: reading only the cwd-local pointer is wrong exactly
when it isn't the newest. A trailing `+Nh after header` on a row means the file was edited
after its own `**Last wrapped:**` was written — by hand, or by a reconcile that never stamped.
`--stamp` moves the header's timestamp whenever it certifies new content, so a stamped reconcile
does not show it.
A trailing `+N commits` means the repo moved on after the pointer was written, and the header
repeats the count for the newest one. Age measures the file; that measures the code it describes,
and the two come apart exactly when a handoff is most misleading.

The other two markers are about the file itself. `header Nh ahead of file` is the reverse of
`after header` and always a bug: a header cannot postdate the file it heads, and every window
derived from one that does is short by exactly the error. `oversize:NNKB` means the pointer is
past 16 KB — `/wrap` sees it before the merge, which is the last point anything can be trimmed.

`--since <path>` is the evidence behind that count — the commits and files that landed after the
file's own header, plus how much is still uncommitted. It answers "which of these open threads are
already done?" in one call, which is the question that costs the most turns when a session ended
without a wrap. It reports four states and never guesses between them: `N commits`, `0 commits …
still describes HEAD` (the all-clear), `0 commits · N uncommitted … predates uncommitted work`, and
`window unknown` (no repo, no commits yet, no header, absent file). Paths are resolved against the
cwd first and the project root second, so the relative path the listing prints can be handed
straight back.

### `SessionStart` hook

Fires on session startup, `/clear`, and post-compact. Walks up to the project root (nearest `.git` or `CLAUDE.md`), recursively scans for `NEXT_SESSION.md` files (depth 4, with an ignore list), and emits a one-line banner if any are found, on both channels: `systemMessage` for the terminal and `additionalContext` for the model, so a session knows a pointer exists without loading it. The banner names the file(s); the terminal copy suggests `/next`, the model's copy says the user may run it and not to run it unprompted. **The handoff content is not loaded into context until you ask** — so a fresh session stays clean if you don't want to pick up.

Four states:

| Local file? | Siblings elsewhere? | Hook output |
|---|---|---|
| yes | — | banner with mtime, suggests `/next`, lists siblings if any |
| no | yes | banner listing sibling paths and mtimes |
| no | no, scan complete | silent (`{}`) |
| no | none found, scan cut | one line saying how many dirs went unsearched |

The scan prunes hidden directories (any name starting with `.`) and gitignored directories (via one `git ls-files --others --ignored --exclude-standard --directory -z` call at scan start). A gitignored *file* named `NEXT_SESSION.md` is still surfaced — only directories are pruned. When the scan exceeds `CONTINUITY_SLOW_MS` milliseconds (default 500), the banner gains a suffix naming the heaviest top-level directories walked, so you know what to add to `.gitignore`. The suffix is only appended when there is otherwise a banner to emit — a slow scan with no handoffs stays silent.

The walk also has a time budget, `CONTINUITY_SCAN_MS` (default 2000). With no `.git` or `CLAUDE.md` above the cwd the scan starts at the cwd itself, and a cwd holding large network or FSKit mounts would otherwise walk them until the hook's 10-second timeout killed it — printing nothing, which reads exactly like "no handoff". Past the budget the scan stops descending and counts the directories it skipped; the banner and `/next`'s report both say so, including when nothing was found. A cut scan is never silent.

`/wrap` adds one more nicety: when it writes `NEXT_SESSION.md` in a git repo and the file is neither in `.gitignore` nor already tracked, the final report prints a single-line suggestion to gitignore it. The skill never edits `.gitignore` — it just suggests.

The hook is best-effort. Any error path emits `{}` and exits 0 — it never blocks the session.

**Re-fire suppression:** Claude Code fires `SessionStart` on several lifecycle events (startup, resume, /clear, /compact). A single logical session can fire the hook 10+ times, drowning the banner in repeated noise. The hook reads `session_id` from its stdin payload, marks first-fire in `~/.claude/state/continuity-firstfire/<session_id>`, and exits silently (`{}`) on subsequent fires within 7 days — except a `/compact` fire, which re-sends the model's copy of the banner (and not the terminal's). A compaction summary drops the banner from the model's context: measured with a stand-in hook, 2 of 2 compactions lost it and letting the compact fire through restored it. If the harness doesn't pass a session_id (e.g., older Claude Code), suppression is skipped and every fire emits — degrading to the prior behavior, never blocking.

**Settings-watcher caveat:** if you install the hook into `~/.claude/settings.json` while a Claude Code session is already running, the hook won't fire in that session. Start a fresh `claude` process to pick it up.

**Debug mode:** set `CONTINUITY_DEBUG=1` in the hook command in settings.json to append one line per invocation to `~/.claude/continuity-hook.log` (cwd, project root, file count, emit type, whether the fire was suppressed). Useful for verifying the hook is being invoked and finding what it sees.

## What the tooling journal captures

`~/.claude/tooling-journal.md` is an append-only record of how your tooling stack performed across sessions. Each `##` heading is one `/wrap` invocation.

Each entry credits a single tool with one of three verdicts:

- **`helped`** — output the session actually used.
- **`hurt`** — wasted time/tokens, produced wrong info, or required correction.
- **`neutral`** — ran without error and without observable signal.

Scope is deliberately narrow: **only what you can change.** Skills you've installed, MCP servers, hooks, project-specific tools. Built-in Claude Code tools (Read/Write/Edit/Bash/Skill/etc.) are out of scope — they're not under your control, so journaling them doesn't help.

`Action:` lines are the highest-value content. Example:

```markdown
### my-mcp-server  •  used 3x, 2 errors  •  verdict: hurt
- Returns paginated results without a cursor field. Had to manually concat 3 calls.
- Action: file an issue requesting cursor pagination, or write a wrapper skill that handles concat.
```

Read it with the CLI, not a grep. Paths below are relative to the plugin root — `~/.claude/plugins/cache/enfurbish/continuity/<version>/` when installed, or `continuity/` in a checkout:

```bash
J=~/.claude/tooling-journal.md
bun run lib/journal-append.ts --journal $J --actions
bun run lib/journal-append.ts --journal $J --actions --tool continuity
bun run lib/journal-append.ts --journal $J --recent scan.ts
```

`--actions` is the improvement backlog, carrying the qualifier the original wrap attached (`(recurring, unmoved)`, `(10th repetition)`). Every open row carries a `#id`, a short hash of its own text. Closes come first in a `closed:` block, because a reader who never reaches a retired action logs it again, then the newest open ones, then `stale:`, the five oldest nobody has retired, with one line under the label saying what to do with them. The tail is there because recency alone made the backlog write-only: at 20 rows against 336 actions an item left the view in about four days and was never displayed again, and an action nobody sees is one nobody can close. `--recent` returns whole sections for one tool. Both match tool names loosely, which is the point: headings and action prefixes are free text a model composed, and they drift.

How much drift, measured against one real 130-wrap journal: `grep '^- Action:'` reached 143 of 241 action lines, and the 98 it missed skewed toward the long-running ones (`Action (recurring, unmoved)` ×17, `(10th repetition)` ×3). `grep '^### continuity'` reached 109 of 134 sections, across 35 distinct spellings of one plugin's name. Your journal will differ; the failure mode won't.

Entries are written the same way — `/wrap` hands `journal-append.ts` JSON and `formatEntry` renders the on-disk shape. Raw markdown on stdin still appends verbatim for retroactive or hand-written entries. A `closed` array on a tool's entry renders `- Closed: …` lines, which is how a standing action leaves the backlog: a close retires exactly the `#id`s it names, from every block and under any heading, and the append prints what each close retired and flags one that retired nothing. Prose alone was the design until 0.10.0; every prose close was paired correctly by a reader, but none of them ever left the view.

## What `/wrap` measures

The retro and journal entry are informed by `scan.ts`, which parses the current session's transcript at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. It reports:

- Session start/end timestamps and duration
- User turn count vs model turn count. A user turn is a typed prompt, a slash command, or a pasted attachment; the records Claude Code synthesizes into the user role are excluded — the tag-wrapped ones (`<task-notification>`, `<local-command-stdout>`, `<system-reminder>`), tool results, `[Request interrupted by user]`, and anything flagged `isMeta` (relayed agent messages, `/loop` re-fires, skill bodies) or `isCompactSummary`.
- Per-tool call counts and error counts, bucketed into `tools` (built-ins) vs `mcp` (`mcp__*` calls)
- Hooks that fired during the session and how many times
- `compaction_count` — number of `compact_boundary` events. A compaction does not truncate the transcript, so the counts above still cover the whole session.
- Skills invoked — both `Skill` tool calls and slash commands typed by the user, so built-in commands (`/clear`, `/compact`) appear here too
- Files edited (most-recent first, capped at 50)
- Number of files read

Subagent activity (`isSidechain: true`) is filtered out — those events belong to the subagent's own session, not the parent's stats.

Scan failures are signaled in-band as `{ ok: false, degraded: true, reason }` rather than thrown — `/wrap` continues with self-reported stats and notes "stats unavailable" in the journal entry.

## NEXT_SESSION.md format

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

<!-- wrap-generation 0123456789abcdef -->
```

The header block is rendered by `handoffs.ts --header`, not typed — the same file parses `**Last wrapped:**` back out, so one function owns both ends. The timestamp isn't an argument either: the command stamps the clock, because a wrap that composed one from memory wrote UTC clock-time carrying a CDT offset and every `--since` window derived from it was five hours short, silently. The body beneath it is prose the wrap composes; nothing parses it.

A project that tracks its open items in another tool says so in the file, in a section standing where `## Open threads` would be, naming the tool and the commands that read it. `/wrap` then records resolutions and new items there instead of copying the list into the file, and `/next` reads the list from there. The file keeps its prose sections. Nothing in the plugin names the tool — the file does — so the same skills work in a project with no such tool at all.

The trailing `wrap-generation` line is a hash of the file's own content. `/wrap` writes it, and the next wrap compares it back: matching means nothing has touched the file since, so the per-item merge may proceed; not matching means someone hand-edited it and their notes must be preserved. It replaced an mtime test that misclassified the assistant's own writes as the user's.

Scoped per cwd by design. A multi-package repo (`frontend/`, `api/`) can hold independent continuity threads; the SessionStart hook walks up to the project root and lists any siblings it finds, so nothing is forgotten.

## Files this plugin writes

| File | When | Owner |
|---|---|---|
| `~/.claude/sessions/YYYY-MM-DD-<slug>-<sid8>.md` | every `/wrap` — never under `-q` | plugin |
| `~/.claude/tooling-journal.md` | every `/wrap` with a verdict to record (appended, atomic temp+rename) — never under `-q` | plugin |
| `<cwd>/NEXT_SESSION.md` | every `/wrap`, unless all items resolved | plugin |
| `~/.claude/state/continuity-firstfire/<session_id>` | first `SessionStart` fire of each session (re-fire suppression) | plugin |
| `<cwd>/CLAUDE.md` or `~/.claude/CLAUDE.md` | only with explicit user confirmation | user |

The plugin never modifies CLAUDE.md without asking. CLAUDE.md is user-authored, often committed to git, and durable — too important to mutate autonomously.

## Installation

```
/plugin marketplace add nullphase-net/enfurbish
/plugin install continuity@enfurbish
```

Once installed:
- `/wrap` and `/next` appear as slash commands
- The `SessionStart` hook fires automatically

## Requirements

- [Bun](https://bun.sh) on `PATH` — the lib scripts and hook are TypeScript run directly via `bun run`.
- A Claude Code installation that supports plugins.

## License

MIT.
