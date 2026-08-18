# continuity

Intentional session continuity for Claude Code.

A plugin that closes the loop between Claude Code sessions: `/wrap` ends a session by producing a retro, a tooling-stack verdict, and a handoff note. A `SessionStart` hook surfaces the handoff at the start of the next session. `/next` is a manual mirror for when the hook didn't fire.

## Commands

### `/wrap`

Run at the end of a session. Produces three files:

- **Retro** — `~/.claude/sessions/YYYY-MM-DD-<cwd-slug>-<sid8>.md`. Dated record of the session: what happened, what was learned, how the tooling performed.
- **Tooling-journal entry** — appended to `~/.claude/tooling-journal.md`. Cross-session verdicts on the parts of your stack you can change.
- **Handoff** — `<cwd>/NEXT_SESSION.md`. What the next session should pick up. Reconciled with any existing file: items survive until they're actually done, not until the next wrap fires.

`/wrap -q` (or `--quick`) does only the local repo work — `NEXT_SESSION.md` and any CLAUDE.md routing. No retro, no journal entry. For a session whose value is a clean pointer rather than a retrospective.

### `/next`

Read-only. Lists every `NEXT_SESSION.md` under the project root, reads the newest, and summarizes "Start here" + "Open threads". Reading the *newest* rather than the cwd-local one is deliberate: cwd varies between sessions in one project, and an autonomous run in a subdirectory writes its own handoff. Use when the SessionStart hook didn't fire or you want to re-consult mid-session.

### `SessionStart` hook

Fires on session startup, `/clear`, and post-compact. Walks up to the project root (nearest `.git` or `CLAUDE.md`), recursively scans for `NEXT_SESSION.md` files (depth 4, with an ignore list), and emits a `systemMessage` banner if any are found. The banner names the file(s) and suggests `/next`. **The handoff content is not loaded into context until you ask** — so a fresh session stays clean if you don't want to pick up.

Three states:

| Local file? | Siblings elsewhere? | Hook output |
|---|---|---|
| yes | — | banner with mtime, suggests `/next`, lists siblings if any |
| no | yes | banner listing sibling paths and mtimes |
| no | no | silent (`{}`) |

The scan prunes hidden directories (any name starting with `.`) and gitignored directories (via one `git ls-files --others --ignored --exclude-standard --directory -z` call at scan start). A gitignored *file* named `NEXT_SESSION.md` is still surfaced — only directories are pruned. When the scan exceeds `CONTINUITY_SLOW_MS` milliseconds (default 500), the banner gains a suffix naming the heaviest top-level directories walked, so you know what to add to `.gitignore`. The suffix is only appended when there is otherwise a banner to emit — a slow scan with no handoffs stays silent.

`/wrap` adds one more nicety: when it writes `NEXT_SESSION.md` in a git repo and the file is neither in `.gitignore` nor already tracked, the final report prints a single-line suggestion to gitignore it. The skill never edits `.gitignore` — it just suggests.

The hook is best-effort. Any error path emits `{}` and exits 0 — it never blocks the session.

**Re-fire suppression:** Claude Code fires `SessionStart` on several lifecycle events (startup, resume, /clear, /compact). A single logical session can fire the hook 10+ times, drowning the banner in repeated noise. The hook reads `session_id` from its stdin payload, marks first-fire in `~/.claude/state/continuity-firstfire/<session_id>`, and exits silently (`{}`) on subsequent fires within 7 days. If the harness doesn't pass a session_id (e.g., older Claude Code), suppression is skipped and every fire emits — degrading to the prior behavior, never blocking.

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

Read it with the CLI, not a grep:

```bash
bun run continuity/lib/journal-append.ts --journal ~/.claude/tooling-journal.md --actions
bun run continuity/lib/journal-append.ts --journal ~/.claude/tooling-journal.md --actions --tool continuity
bun run continuity/lib/journal-append.ts --journal ~/.claude/tooling-journal.md --recent scan.ts
```

`--actions` is the improvement backlog, newest first, carrying the qualifier the original wrap attached (`(recurring, unmoved)`, `(10th repetition)`). `--recent` returns whole sections for one tool. Both match tool names loosely, which is the point: headings and action prefixes are free text a model composed, and they drift. Measured over ~130 wraps, `grep '^- Action:'` reached 143 of 241 action lines, and the 98 it missed were disproportionately the long-running ones. `grep '^### continuity'` reached 109 of 134 sections across 35 spellings.

Entries are written the same way — `/wrap` hands `journal-append.ts` JSON and `formatEntry` renders the on-disk shape. Raw markdown on stdin still appends verbatim for retroactive or hand-written entries.

## What `/wrap` measures

The retro and journal entry are informed by `scan.ts`, which parses the current session's transcript at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. It reports:

- Session start/end timestamps and duration
- User turn count vs model turn count (post-compaction only when `compaction_count > 0` — see below). A user turn is a typed prompt, a slash command, or a pasted attachment; the records Claude Code synthesizes into the user role (`<task-notification>`, `<local-command-stdout>`, `<system-reminder>`, tool results) are excluded.
- Per-tool call counts and error counts, bucketed into `tools` (built-ins) vs `mcp` (`mcp__*` calls)
- Hooks that fired during the session and how many times
- `compaction_count` — number of `compact_boundary` events. Non-zero means turn counts are partial (everything before the last compaction is not in this transcript segment).
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

The header block is rendered by `handoffs.ts --header`, not typed — the same file parses `**Last wrapped:**` back out, so one function owns both ends. The body beneath it is prose the wrap composes; nothing parses it.

The trailing `wrap-generation` line is a hash of the file's own content. `/wrap` writes it, and the next wrap compares it back: matching means nothing has touched the file since, so the per-item merge may proceed; not matching means someone hand-edited it and their notes must be preserved. It replaced an mtime test that misclassified the assistant's own writes as the user's.

Scoped per cwd by design. A multi-package repo (`frontend/`, `api/`) can hold independent continuity threads; the SessionStart hook walks up to the project root and lists any siblings it finds, so nothing is forgotten.

## Files this plugin writes

| File | When | Owner |
|---|---|---|
| `~/.claude/sessions/YYYY-MM-DD-<slug>-<sid8>.md` | every `/wrap` | plugin |
| `~/.claude/tooling-journal.md` | every `/wrap` with a verdict to record (appended, atomic temp+rename) | plugin |
| `<cwd>/NEXT_SESSION.md` | every `/wrap`, unless all items resolved | plugin |
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
