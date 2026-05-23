# Continuity SessionStart Scan Cluster — Design

**Status:** Approved 2026-05-22. Awaiting implementation plan.

## Goal

Improve the continuity SessionStart scan in three coupled ways:

1. **Faster scan** — honor `.gitignore` and skip hidden (`.`-prefixed) directories so deep checkouts with heavy build artifacts (`.next/`, `.cache/`, `dist/`, etc.) don't get walked at hook-fire time.
2. **Informed timing** — when the scan does run long, the banner tells the user *what's heavy* (named top-contributor directories), not just *that it was slow*.
3. **Handoff hygiene** — when `/wrap` writes `NEXT_SESSION.md` in a git repo where the file is neither ignored nor tracked, the final report includes a one-line suggestion to add it to `.gitignore`. Suggestion, never edit.

Addresses TODO items #6, #7, #8. Defers #1 (date deltas) and the SessionStart re-fire informer (separate spec).

## Scope

**In:**
- `continuity/hooks/session-start.ts` — scan filtering, timing, optional slow-note suffix.
- `continuity/skills/wrap/SKILL.md` — final-report gitignore suggestion (calls a new CLI mode of the helper).
- `continuity/lib/gitignore.ts` — new module: three thin helpers wrapping `git`, plus a `--suggest-line` CLI mode for the wrap skill.
- Tests for all of the above.

**Out:**
- Auto-editing `.gitignore`. The wrap skill's "Out of scope: `.gitignore` management" note stays — we suggest only.
- Date-delta formatting (TODO #1). Cross-cutting, separate spec.
- SessionStart re-fire detect/inform (separate spec, will reuse the transcript-counting pattern from `continuity/lib/scan.ts`).
- `affirm` plugin. Different scope.

## Design

### `continuity/lib/gitignore.ts` (new, ~50 LOC)

Three exported functions and one CLI entry point. All shell out to `git` with a short timeout, swallow errors, return safe defaults when git is unavailable or the directory isn't a repo.

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

CLI mode:

```bash
bun run continuity/lib/gitignore.ts --suggest-line NEXT_SESSION.md
```

Prints one suggestion line (or empty) per the conditions in the wrap section below. Used by `SKILL.md` to splice into the final report.

### `continuity/hooks/session-start.ts` (modified)

Three behavior additions, each independent and degrading silently when git isn't available.

**1. Skip dotdirs.** Any directory entry whose name starts with `.` is pruned. New constant or inline check; combines with the existing `IGNORE_DIRS` set (which keeps its non-dot entries like `node_modules`, `vendor`, etc.).

**2. Skip gitignored dirs.** At scan start, call `getIgnoredDirs(projectRoot)`. During walk, check absolute directory paths against the Set; skip if present. Falls back to dotdir+`IGNORE_DIRS` only when the Set is empty (non-git or git unavailable).

**3. Timing + slow-note.** Wrap the walker in `performance.now()`. Pass a `walks: Map<string, number>` (keyed by first-segment path under `projectRoot`) into the walker; the walker bumps the counter each time it enters a directory. After scan, if `elapsedMs > slowMs` (default 250, overridable via `CONTINUITY_SLOW_MS` env), build a slow-note suffix:

```
(slow scan: 2.3s · 1245 dirs · top: ./coverage × 412, ./reports × 320)
```

- Sort `walks` descending, take top 2 contributors.
- Paths shown relative to `projectRoot` with `./` prefix.
- If only one contributor matters (or only one was walked), show one.
- If the scan was fast: no suffix, banner unchanged.

The suffix is appended to whatever banner `buildBanner(...)` produces (handoff present, or sibling-only, or null). When `buildBanner` returns `null` (no handoffs found) the slow-note is *still* worth emitting if the threshold was crossed — surface it as a standalone banner: `Continuity: no handoffs, but scan was slow. <suffix>`. The threshold-crossing itself is the signal worth showing.

### `continuity/skills/wrap/SKILL.md` (modified)

Section 5 (NEXT_SESSION.md lifecycle) gains a final sub-step after the file is written/preserved:

```bash
# Append a gitignore suggestion line if applicable (empty otherwise).
SUGGEST=$(bun run "<skill-base-dir>/../../lib/gitignore.ts" --suggest-line NEXT_SESSION.md)
```

The skill includes `$SUGGEST` (if non-empty) as a final line of the Section 7 "Final report" block:

```
/wrap complete:
  Retro:          ~/.claude/sessions/...
  Journal:        ~/.claude/tooling-journal.md (appended)
  NEXT_SESSION:   written
  CLAUDE.md:      none
  Note: NEXT_SESSION.md isn't gitignored — consider adding it so it stays out of commits and worktrees.
```

**Conditions for the suggestion line to be non-empty** (all four must hold):
1. The current invocation wrote `NEXT_SESSION.md` (not "preserved", not "removed", not "absent").
2. The project is a git repo.
3. `NEXT_SESSION.md` is not in `.gitignore` (`!isFileIgnored`).
4. `NEXT_SESSION.md` is not tracked by git (`!isFileTracked`).

Condition 4 means users who deliberately commit `NEXT_SESSION.md` aren't nagged. Condition 1 is communicated by the skill passing a flag/arg to the CLI, e.g. `--for-write` (when other modes don't pass it, no suggestion).

The existing "Out of scope: `.gitignore` management for `NEXT_SESSION.md`" line stays in SKILL.md — we suggest, never edit.

## Banner shape (terse, rich, pivots — per project invariant)

Examples of the three relevant slow-note pivots:

```
Continuity: NEXT_SESSION.md present from your last wrap (modified 2026-05-22 18:04 UTC). Run /next to pick it up. (slow scan: 2.3s · 1245 dirs · top: ./coverage × 412, ./reports × 320)
```

```
Continuity: no NEXT_SESSION.md in this cwd, but 2 handoffs in sibling dirs:
  - foo/NEXT_SESSION.md  (modified 2026-05-21 09:00)
  - bar/NEXT_SESSION.md  (modified 2026-05-20 18:00)
(slow scan: 2.3s · 1245 dirs · top: ./coverage × 412)
```

```
Continuity: no handoffs, but scan was slow. (slow scan: 2.3s · 1245 dirs · top: ./coverage × 412, ./reports × 320)
```

When fast: banner exactly as it is today.

## Error handling

All git-querying paths degrade silently:

- `getIgnoredDirs` returns an empty Set if git is missing, the dir isn't a repo, or the command times out (5 s ceiling). Scanner falls back to dotdir + `IGNORE_DIRS` pruning only.
- `isFileIgnored` / `isFileTracked` return `false` on any error. The wrap suggestion just won't fire — better than crashing or saying something wrong.
- The slow-scan note never fails — pure timing math.
- The hook keeps its existing invariant: any uncaught error → `{}` + exit 0. No new failure modes affect session startup.

## Testing

All tests via `bun:test`, all fixtures via `mkdtempSync` + (where needed) `git init`.

**`continuity/tests/gitignore.test.ts` (new) — ~7 tests:**
- `getIgnoredDirs` returns empty Set outside a repo.
- `getIgnoredDirs` lists a gitignored directory by absolute path.
- `getIgnoredDirs` does **not** list a gitignored *file* (verifies the trailing-`/` filter — crucial for not skipping `NEXT_SESSION.md` itself).
- `isFileIgnored` true / false cases.
- `isFileTracked` true / false cases.
- CLI `--suggest-line NEXT_SESSION.md --for-write`: prints suggestion when all 4 conditions hold.
- CLI `--suggest-line NEXT_SESSION.md --for-write`: prints empty when any condition fails (tracked, ignored, non-git, etc.).

**`continuity/tests/session-start.test.ts` (extend) — ~5 new tests:**
- Scan skips a `.cache` dir (dotdir).
- Scan skips a gitignored `dist/` (git fixture; ensures the Set is built and applied).
- Scan still finds a gitignored `NEXT_SESSION.md` at the project root (verifies the directory-only filter end-to-end).
- Slow-scan suffix appears when `CONTINUITY_SLOW_MS=0` forces the path; suffix contains a `top:` portion.
- Fast-scan run has no timing suffix in the banner.

## Out of scope (explicit non-goals for this work)

- Auto-edit `.gitignore`. Suggestion only.
- Tune `IGNORE_DIRS` beyond keeping its current contents alongside the new dotdir + gitignore layers. (Could happen later if the slow-note keeps surfacing specific dirs as top contributors.)
- Date-delta format for handoff `modified` times — separate spec (TODO #1).
- SessionStart re-fire detect/inform — separate spec. Will reuse the existing `continuity/lib/scan.ts` transcript-derived `hooks: { SessionStart: { fired: N } }` pattern at fire-time rather than introducing a new state file.
- Any change to `affirm`.

## Open follow-ups (parking lot)

- TODO #1 (date deltas).
- TODO: SessionStart re-fire detect/inform (both plugins).
- TODO: tighten `affirm` details mode per the bewray output style.
- Release flow: per `RELEASING.md`, this is a **minor** bump for `continuity` (new behaviors). Plan tag: `continuity-v0.3.0` once merged.
