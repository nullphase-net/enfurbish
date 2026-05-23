# Continuity SessionStart Scan Cluster — Design

**Status:** Revised 2026-05-22 after sibling-session review. Awaiting re-approval before implementation plan.

## Goal

Improve the continuity SessionStart scan in three coupled ways:

1. **Faster scan** — honor `.gitignore` and skip hidden (`.`-prefixed) directories so deep checkouts with heavy build artifacts (`.next/`, `.cache/`, `dist/`, etc.) don't get walked at hook-fire time.
2. **Informed timing** — when the scan does run long, the banner tells the user *what's heavy* (named top-contributor directories), not just *that it was slow*.
3. **Handoff hygiene** — when `/wrap` writes `NEXT_SESSION.md` in a git repo where the file is neither ignored nor tracked, the final report includes a one-line suggestion to add it to `.gitignore`. Suggestion, never edit.

Addresses three TODO items: "SessionStart scan should ignore .gitignore and hidden paths", "time the scan and inform if slow", and "suggest gitignoring NEXT_SESSION.md". Defers the date-deltas TODO and the SessionStart re-fire informer (separate spec).

## Scope

**In:**
- `continuity/hooks/session-start.ts` — scan filtering, timing, optional slow-note suffix.
- `continuity/skills/wrap/SKILL.md` — final-report gitignore suggestion (calls a new CLI mode of the helper).
- `continuity/lib/gitignore.ts` — new module: three thin helpers wrapping `git`, plus a `--suggest-line` CLI mode for the wrap skill.
- Tests for all of the above.

**Out:**
- Auto-editing `.gitignore`. The wrap skill's "Out of scope: `.gitignore` management" note stays — we suggest only.
- Date-delta formatting (the "date deltas" TODO). Cross-cutting, separate spec.
- SessionStart re-fire detect/inform (separate spec, will reuse the transcript-counting pattern from `continuity/lib/scan.ts`).
- `affirm` plugin. Different scope.

## Design

### `continuity/lib/gitignore.ts` (new, ~50 LOC)

Three exported functions and one CLI entry point. All shell out to `git` via `child_process.spawnSync(..., { timeout: 5000 })` (verified to honor the timeout in Bun), swallow errors, return safe defaults when git is unavailable or the directory isn't a repo.

```ts
export function getIgnoredDirs(projectRoot: string): Set<string>;
// One `git ls-files --others --ignored --exclude-standard --directory -z` call.
// Returns an absolute-path Set of *directories only* (entries with trailing `/`
// in git output). Empty Set on any error.

export function isFileIgnored(projectRoot: string, relPath: string): boolean;
// `git check-ignore -q <relPath>` → exit 0 = ignored. false on any other exit.

export function isFileTracked(projectRoot: string, relPath: string): boolean;
// `git ls-files --error-unmatch <relPath>` → exit 0 = tracked. false otherwise.
```

Critical detail in `getIgnoredDirs`: the trailing-`/` filter is what makes this safe to use for scan pruning. A gitignored *file* named `NEXT_SESSION.md` must still be findable by the scan — the filter only excludes directories.

**Note on cost.** `getIgnoredDirs` parses git's NUL-delimited output into a Set — bounded by the project's ignored-tree size, not capped. In practice this is fine (git itself completes fast; output is proportional). In pathological monorepos with massive ignored trees, the parse could allocate megabytes. Not optimizing in v1; the 5 s spawn timeout is the only ceiling.

**Edge case acknowledged.** If a user keeps `NEXT_SESSION.md` inside a directory they've also gitignored (e.g., `coverage/NEXT_SESSION.md`), the dir-prune skips it — that file won't be surfaced. This is intentional: a gitignored directory is "out of sight" by user choice, and the cost of traversing it negates the perf gain.

CLI mode:

```bash
bun run continuity/lib/gitignore.ts --suggest-line NEXT_SESSION.md
```

Prints one suggestion line (or empty) per the conditions in the wrap section below. Used by `SKILL.md` to splice into the final report.

### `continuity/hooks/session-start.ts` (modified)

Three behavior additions, each independent and degrading silently when git isn't available.

**1. Skip dotdirs.** Any directory entry whose name starts with `.` is pruned. New constant or inline check; combines with the existing `IGNORE_DIRS` set (which keeps its non-dot entries like `node_modules`, `vendor`, etc.).

**2. Skip gitignored dirs.** At scan start, call `getIgnoredDirs(projectRoot)`. During walk, check absolute directory paths against the Set; skip if present. Falls back to dotdir+`IGNORE_DIRS` only when the Set is empty (non-git or git unavailable).

**Pruning-check order.** Cheap before expensive: (a) `name.startsWith('.')`, (b) `IGNORE_DIRS.has(name)`, then (c) `ignoredSet.has(join(parentAbs, name))`. Avoids allocating absolute paths for the common case where the cheap checks already eliminate the entry.

**3. Timing + slow-note.** Wrap the walker in `performance.now()`. Pass a `walks: Map<string, number>` (keyed by first-segment path under `projectRoot`) into the walker; the walker bumps the counter each time it enters a directory. After scan, if `elapsedMs > slowMs` (default **500**, overridable via `CONTINUITY_SLOW_MS` env), build a slow-note suffix:

```
(slow scan: 2.3s · 1245 dirs · top: ./coverage 412 dirs, ./reports 320 dirs)
```

- Sort `walks` descending, take top 2 contributors.
- Paths shown relative to `projectRoot` with `./` prefix.
- `N dirs` makes the unit explicit (subdirectories walked under that path).
- If only one contributor matters (or only one was walked), show one.
- If the scan was fast: no suffix, banner unchanged.

The slow-note is **suffix-only** — appended to whatever banner `buildBanner(...)` produces (handoff present, or sibling-only). When `buildBanner` returns `null` (no handoffs found), the slow-note is **not** emitted as a standalone banner. Rationale: users who set up continuity but don't actually use `NEXT_SESSION.md` workflows would otherwise see slow-notes every session as pure noise. A follow-up enhancement can surface "first slow scan of the session" via the transcript-counting pattern (deferred — same primitive as the SessionStart re-fire informer spec).

### `continuity/skills/wrap/SKILL.md` (modified)

Section 5 (NEXT_SESSION.md lifecycle) gains a final sub-step that runs **only on the write path** — i.e., when this invocation actually wrote `NEXT_SESSION.md` (not when it was preserved-user-edited, removed, or absent). The skill must branch:

```bash
# Inside Section 5, only on the write path (after writing the merged file):
SUGGEST=$(bun run "<skill-base-dir>/../../lib/gitignore.ts" --suggest-line NEXT_SESSION.md --for-write)

# On preserved/removed/absent paths: do NOT call --for-write, or skip the call entirely.
# (Calling without --for-write also returns empty — both forms are safe no-ops.)
```

The skill includes `$SUGGEST` (if non-empty) as a final line of the Section 7 "Final report" block:

```
/wrap complete:
  Retro:          ~/.claude/sessions/...
  Journal:        ~/.claude/tooling-journal.md (appended)
  NEXT_SESSION:   written
  CLAUDE.md:      none
  Note: NEXT_SESSION.md isn't gitignored — consider adding `NEXT_SESSION.md` to .gitignore so it stays out of commits.
```

**Conditions for the suggestion line to be non-empty** (all four must hold):
1. The CLI was called with `--for-write` (i.e., this invocation wrote the file).
2. The project is a git repo.
3. `NEXT_SESSION.md` is not in `.gitignore` (`!isFileIgnored`).
4. `NEXT_SESSION.md` is not tracked by git (`!isFileTracked`).

Condition 4 means users who deliberately commit `NEXT_SESSION.md` aren't nagged. Condition 1 routes the "preserved/removed/absent" branches around the suggestion entirely.

**Suggested gitignore pattern is unanchored** (`NEXT_SESSION.md`, not `/NEXT_SESSION.md`). Multi-package repos may have per-cwd handoffs in subdirectories; the unanchored form catches all of them. If a user wants only the root file ignored they can edit afterward — we suggest the conservative default.

**Wording note.** Earlier drafts said "stays out of commits and worktrees." Untracked files don't propagate into worktrees (each worktree has its own working tree), so the worktree clause was misleading. Suggestion text says "stays out of commits" only.

The existing "Out of scope: `.gitignore` management for `NEXT_SESSION.md`" line stays in SKILL.md — we suggest, never edit.

## Banner shape (terse, rich, pivots — per project invariant)

Suffix-only slow-note. Examples:

Handoff at cwd, slow:
```
Continuity: NEXT_SESSION.md present from your last wrap (modified 2026-05-22 18:04 UTC). Run /next to pick it up. (slow scan: 2.3s · 1245 dirs · top: ./coverage 412 dirs, ./reports 320 dirs)
```

Sibling handoffs, slow (one dominant contributor):
```
Continuity: no NEXT_SESSION.md in this cwd, but 2 handoffs in sibling dirs:
  - foo/NEXT_SESSION.md  (modified 2026-05-21 09:00)
  - bar/NEXT_SESSION.md  (modified 2026-05-20 18:00)
(slow scan: 2.3s · 1245 dirs · top: ./coverage 412 dirs)
```

No handoffs (slow or fast): banner is `{}` either way. Slow-scan info is not surfaced when there's nothing else to say.

When fast (and handoffs present): banner exactly as it is today, no suffix.

## Error handling

All git-querying paths degrade silently:

- `getIgnoredDirs` returns an empty Set if git is missing, the dir isn't a repo, or the command times out (5 s ceiling). Scanner falls back to dotdir + `IGNORE_DIRS` pruning only.
- `isFileIgnored` / `isFileTracked` return `false` on any error. The wrap suggestion just won't fire — better than crashing or saying something wrong.
- The slow-scan note never fails — pure timing math.
- The hook keeps its existing invariant: any uncaught error → `{}` + exit 0. No new failure modes affect session startup.

## Testing

All tests via `bun:test`, all fixtures via `mkdtempSync` + (where needed) `git init`.

**Fixture isolation.** Every `git init` fixture sets `GIT_CONFIG_NOSYSTEM=1` and overrides `HOME` and `XDG_CONFIG_HOME` to the fixture's temp dir before running git. Without this, a developer's global git config (`init.templateDir`, `core.excludesFile`, global hooks) leaks into the fixture and tests become CI-flaky. The fixture helper exposes `gitInit(dir)` and `gitInitClean(dir)` (latter applies the env overrides explicitly).

**`continuity/tests/gitignore.test.ts` (new) — ~9 tests:**
- `getIgnoredDirs` returns empty Set outside a repo.
- `getIgnoredDirs` lists a gitignored directory by absolute path.
- `getIgnoredDirs` does **not** list a gitignored *file* (verifies the trailing-`/` filter — crucial for not skipping `NEXT_SESSION.md` itself).
- `getIgnoredDirs` with a nested `.gitignore` inside an already-ignored dir (e.g., `.venv/` ignored at root + `.venv/.gitignore` exists): only the top-level dir is reported, nested entries don't confuse the filter.
- `isFileIgnored` true / false cases.
- `isFileTracked` true / false cases.
- CLI `--suggest-line NEXT_SESSION.md --for-write`: prints suggestion when all 4 conditions hold.
- CLI `--suggest-line NEXT_SESSION.md --for-write`: prints empty when `NEXT_SESSION.md` is tracked.
- CLI `--suggest-line NEXT_SESSION.md` (without `--for-write`): prints empty regardless of other conditions (Condition 1 not met).

**`continuity/tests/session-start.test.ts` (extend) — ~6 new tests:**
- Scan skips a `.cache` dir (dotdir).
- Scan skips a gitignored `dist/` (git fixture; ensures the Set is built and applied).
- Scan still finds a gitignored `NEXT_SESSION.md` at the project root (verifies the directory-only filter end-to-end).
- Scan does **not** find `NEXT_SESSION.md` inside a gitignored directory (e.g., `coverage/NEXT_SESSION.md` when `coverage/` is ignored — locks in the acknowledged edge case behavior).
- Slow-scan suffix appears when `CONTINUITY_SLOW_MS=0` forces the path; suffix contains a `top:` portion with `N dirs` notation.
- Fast-scan run has no timing suffix in the banner; banner is `{}` when there are no handoffs even if scan was slow (suffix-only invariant).

## Out of scope (explicit non-goals for this work)

- Auto-edit `.gitignore`. Suggestion only.
- Tune `IGNORE_DIRS` beyond keeping its current contents alongside the new dotdir + gitignore layers. (Could happen later if the slow-note keeps surfacing specific dirs as top contributors.)
- Date-delta format for handoff `modified` times — separate spec (the "date deltas" TODO).
- SessionStart re-fire detect/inform — separate spec. Will reuse the existing `continuity/lib/scan.ts` transcript-derived `hooks: { SessionStart: { fired: N } }` pattern at fire-time rather than introducing a new state file.
- Any change to `affirm`.

## Open follow-ups (parking lot)

- Date-delta date format (cross-plugin).
- SessionStart re-fire detect/inform (both plugins) — reuses the `continuity/lib/scan.ts` transcript-counting pattern at fire-time.
- Tighten `affirm` details mode per the bewray output style.
- "First slow scan of the session" surfacer — same primitive as the re-fire informer; would let us bring back something analogous to a standalone slow-banner without per-fire noise.
- `getIgnoredDirs` is also semantically useful inside `affirm` (e.g., suggesting `CLAUDE.md` be added to `.gitignore`); per the CLAUDE.md "plugins do not share lib code" invariant, `affirm` will get its own copy when it needs one.
- Release flow: per `RELEASING.md`, this is a **minor** bump for `continuity` (new behaviors). Plan tag: `continuity-v0.3.0` once merged.
