# `/wrap` — steps 2–4, full wrap only

`SKILL.md` sends you here on a full wrap. `-q` never runs these.

### 2. Pull cross-session journal context

For each tool key in `tools` and `mcp` from the scan, what prior wraps said about it:

```bash
bun run "<skill-base-dir>/../../lib/journal-append.ts" --journal ~/.claude/tooling-journal.md --recent <toolname>
```

The last few verdicts per tool, so patterns show ("same 0% hit rate as prior 5 sessions") instead of evaluating cold. It matches names loosely and reports how many spellings it found; headings are free text and they drift. Don't substitute a `grep`.

Then the standing backlog, once:

```bash
bun run "<skill-base-dir>/../../lib/journal-append.ts" --journal ~/.claude/tooling-journal.md --actions
```

Three blocks: `closed:` first and uncapped, the newest open actions, then `stale:` with the oldest actions nobody has retired and, under the label, what to do with them. The `closed` array it names is the one in step 4's entry. A head row marked `(recurring, unmoved)` or `(10th repetition)` gets the same answer as a stale one: open, done, or never, not an eleventh log line.

No journal yet → both commands report zero; the first append creates it with a header.

### 3. Synthesize the retro file

Fill from the session and the scan:

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
*Only user-modifiable tooling: installed skills, MCP servers, hooks, project-specific tools. Built-in Claude Code tools are not journaled. See step 4.*

### <tool name>
- Used: N times. Verdict: helped / hurt / neutral.
- Specifics: what worked, what friction.

## Follow-ups staged
- [ ] Concrete next step.

## Handoff
- NEXT_SESSION.md: written / preserved / removed (all resolved) / absent
- CLAUDE.md: none / user-confirmed / project-confirmed
```

Write it to `~/.claude/sessions/YYYY-MM-DD-<cwd-slug>-<sessionid8>.md` (`mkdir -p ~/.claude/sessions` if needed).

### 4. Append the journal entry

Hand the entry to `journal-append.ts` as JSON. It renders the on-disk shape; you supply the judgment, not the punctuation:

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
      "closed": ["the standing action you retired, and why"],
      "action": "concrete improvement idea"
    }
  ]
}
JOURNAL
```

`usage`, `notes`, `closed` and `action` are optional. Omit `closed` on the wraps that retire nothing (most of them), and omit `action` when there genuinely isn't one rather than writing "none". Raw markdown on stdin still appends verbatim, for a retroactive or hand-written entry; JSON is the default because a format the model reassembles from memory drifts. Empty stdin is a no-op.

**Verdict:** `helped` — output the session actually used. `hurt` — wasted time or tokens, produced wrong info, or required correction. `neutral` — ran without error and without observable signal either way.

**Include only what the user can change:** skills they installed (`Skill` invocations), MCP servers (anything `mcp__*`), hooks (from `hooks` in the scan), project-specific tools they wrote. Built-in Claude Code tools (Read, Write, Edit, MultiEdit, Bash, Grep, Glob, Skill, Agent/Task, AskUserQuestion, WebSearch, WebFetch, NotebookEdit, etc.) are not under user control: no entries for them, even when they errored.

`action` is the highest-value field in the journal; aim for it. An entry with no concrete observation and no action has not justified its existence. Skip the tool.
