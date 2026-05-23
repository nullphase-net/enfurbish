# Continuity SessionStart Scan Cluster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the scan-cluster spec: faster scan (skip dotdirs + `.gitignore`), informed timing (slow-note suffix with top heavy paths), and a `/wrap` final-report suggestion to gitignore `NEXT_SESSION.md` when applicable.

**Architecture:** A new `continuity/lib/gitignore.ts` module with three thin Node-`child_process` wrappers (`getIgnoredDirs`, `isFileIgnored`, `isFileTracked`) plus a `--suggest-line` CLI mode. `continuity/hooks/session-start.ts` gains a dotdir filter, the gitignored-set filter, and a `performance.now()` timing wrap that emits a suffix on existing banners when the scan exceeds a threshold (default 500 ms). `continuity/skills/wrap/SKILL.md` calls the CLI with `--for-write` only on the actual write path, and splices the returned suggestion (if any) into Section 7's final report. All git-touching paths degrade silently to safe defaults.

**Tech Stack:** Bun runtime, TypeScript (no build step), `node:child_process.spawnSync(..., { timeout: 5000 })` for all git calls (do NOT substitute `Bun.spawnSync` or `Bun.spawn`), `bun:test` for tests.

**Spec:** `docs/superpowers/specs/2026-05-22-continuity-scan-cluster-design.md`

---

## File Structure

**New files:**
- `continuity/lib/gitignore.ts` — three exported helpers + CLI mode for `--suggest-line`.
- `continuity/tests/helpers/git.ts` — `gitInitClean(dir)` fixture helper with env isolation; tests import from here.
- `continuity/tests/gitignore.test.ts` — 9 tests for the helpers + CLI.

**Modified files:**
- `continuity/hooks/session-start.ts` — dotdir filter, gitignored-set filter, timing wrap, slow-note suffix logic.
- `continuity/tests/session-start.test.ts` — 6 new tests.
- `continuity/skills/wrap/SKILL.md` — Section 5 gains the write-path `--for-write` call; Section 7 splices the suggestion.
- `continuity/README.md` — one paragraph noting the new gitignore filter + suggestion flow.
- `continuity/.claude-plugin/plugin.json` — version bump `0.2.1` → `0.3.0`.

**Unchanged:**
- `continuity/lib/scan.ts`, `continuity/lib/journal-append.ts`, `continuity/skills/next/SKILL.md`, plugin/hook manifests other than the version bump.
- Anything under `affirm/`.

---

## Task 1: Test fixture helper with env isolation

**Files:**
- Create: `continuity/tests/helpers/git.ts`

No tests for the helper itself in this task — its correctness will be exercised by every subsequent task. The point of isolating it here is so the helper exists with the right contract before any caller imports it.

- [ ] **Step 1: Create the helper file**

```ts
// continuity/tests/helpers/git.ts
import { spawnSync } from "node:child_process";

export type GitFixture = {
  /** Restore process.env values that gitInitClean overrode. Call in `finally`. */
  cleanup: () => void;
};

/**
 * Initialize a fresh git repo at `dir` with HOME/XDG_CONFIG_HOME/GIT_CONFIG_NOSYSTEM
 * overridden so the developer's global git config (init.templateDir, core.excludesFile,
 * global hooks) cannot leak into the fixture.
 *
 * The env overrides are applied to `process.env` so production code under test
 * inherits them on its own git calls; `cleanup()` restores the originals.
 */
export function gitInitClean(dir: string): GitFixture {
  const orig = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  const opts = { cwd: dir };
  spawnSync("git", ["init", "-q", "-b", "main"], opts);
  spawnSync("git", ["config", "user.email", "test@example.com"], opts);
  spawnSync("git", ["config", "user.name", "Test User"], opts);
  spawnSync("git", ["config", "commit.gpgsign", "false"], opts);

  return {
    cleanup: () => {
      for (const [k, v] of Object.entries(orig) as [keyof typeof orig, string | undefined][]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
```

- [ ] **Step 2: Verify the file compiles (no callers yet, just type-check via bun)**

Run: `bun run continuity/tests/helpers/git.ts`
Expected: exits cleanly with no output (importing the module is a no-op).

- [ ] **Step 3: Commit**

```bash
git add continuity/tests/helpers/git.ts
git commit -m "continuity: add gitInitClean test fixture with env isolation"
```

---

## Task 2: `getIgnoredDirs` helper

**Files:**
- Create: `continuity/lib/gitignore.ts` (new — this task creates the file)
- Create: `continuity/tests/gitignore.test.ts` (new — this task creates the file)

- [ ] **Step 1: Write the failing tests**

Create `continuity/tests/gitignore.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIgnoredDirs } from "../lib/gitignore";
import { gitInitClean } from "./helpers/git";

test("getIgnoredDirs returns empty Set outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-nogit-"));
  writeFileSync(join(dir, "x.md"), "hi");
  expect(getIgnoredDirs(dir).size).toBe(0);
});

test("getIgnoredDirs lists a gitignored directory by absolute path", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-dir-"));
  const fx = gitInitClean(dir);
  try {
    writeFileSync(join(dir, ".gitignore"), "dist/\n");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "out.js"), "build");
    const ignored = getIgnoredDirs(dir);
    expect(ignored.has(join(dir, "dist"))).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("getIgnoredDirs does NOT list a gitignored *file* (trailing-slash filter)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-file-"));
  const fx = gitInitClean(dir);
  try {
    writeFileSync(join(dir, ".gitignore"), "NEXT_SESSION.md\n");
    writeFileSync(join(dir, "NEXT_SESSION.md"), "handoff");
    const ignored = getIgnoredDirs(dir);
    // The ignored file must not appear in the dir-only set; if it did, the
    // SessionStart scan would silently skip the handoff file.
    expect(ignored.has(join(dir, "NEXT_SESSION.md"))).toBe(false);
  } finally {
    fx.cleanup();
  }
});

test("getIgnoredDirs handles nested .gitignore inside an already-ignored dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-nested-"));
  const fx = gitInitClean(dir);
  try {
    writeFileSync(join(dir, ".gitignore"), ".venv/\n");
    mkdirSync(join(dir, ".venv"));
    writeFileSync(join(dir, ".venv", ".gitignore"), "*.pyc\n");
    writeFileSync(join(dir, ".venv", "x.pyc"), "");
    writeFileSync(join(dir, ".venv", "y.py"), "");
    const ignored = getIgnoredDirs(dir);
    // Only the top-level ignored dir is reported; nested entries don't pollute.
    expect(ignored.has(join(dir, ".venv"))).toBe(true);
    expect(ignored.has(join(dir, ".venv", "x.pyc"))).toBe(false);
    expect(ignored.has(join(dir, ".venv", "y.py"))).toBe(false);
  } finally {
    fx.cleanup();
  }
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test continuity/tests/gitignore.test.ts`
Expected: FAIL — `Cannot find module '../lib/gitignore'`

- [ ] **Step 3: Implement `getIgnoredDirs`**

Create `continuity/lib/gitignore.ts`:

```ts
// continuity/lib/gitignore.ts
// All git invocations use node:child_process.spawnSync; do NOT substitute
// Bun.spawnSync or Bun.spawn (different timeout semantics).
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
}

/**
 * One `git ls-files --others --ignored --exclude-standard --directory -z` call.
 * Returns an absolute-path Set of *directories only* (entries with trailing `/`
 * in git output). Empty Set on any error or outside a git repo.
 *
 * Critical: the trailing-`/` filter is what makes this safe to use for scan
 * pruning. A gitignored *file* named NEXT_SESSION.md must still be findable
 * by the scan, so file entries from git ls-files are deliberately discarded.
 */
export function getIgnoredDirs(projectRoot: string): Set<string> {
  const out = new Set<string>();
  const r = git(projectRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  if (r.code !== 0) return out;
  for (const entry of r.stdout.split("\0")) {
    if (entry.length === 0) continue;
    // Directory entries end with "/"; files do not.
    if (!entry.endsWith("/")) continue;
    const rel = entry.slice(0, -1); // strip trailing "/"
    out.add(join(projectRoot, rel));
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test continuity/tests/gitignore.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add continuity/lib/gitignore.ts continuity/tests/gitignore.test.ts
git commit -m "continuity: add getIgnoredDirs helper"
```

---

## Task 3: `isFileIgnored` helper

**Files:**
- Modify: `continuity/lib/gitignore.ts` (add `isFileIgnored`)
- Modify: `continuity/tests/gitignore.test.ts` (add 2 tests)

- [ ] **Step 1: Append failing tests**

Append to `continuity/tests/gitignore.test.ts`:

```ts
import { isFileIgnored } from "../lib/gitignore";

test("isFileIgnored returns true when the file is in .gitignore", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-iisignored-true-"));
  const fx = gitInitClean(dir);
  try {
    writeFileSync(join(dir, ".gitignore"), "NEXT_SESSION.md\n");
    writeFileSync(join(dir, "NEXT_SESSION.md"), "handoff");
    expect(isFileIgnored(dir, "NEXT_SESSION.md")).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("isFileIgnored returns false when the file is not in .gitignore", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-iisignored-false-"));
  const fx = gitInitClean(dir);
  try {
    writeFileSync(join(dir, ".gitignore"), "");
    writeFileSync(join(dir, "NEXT_SESSION.md"), "handoff");
    expect(isFileIgnored(dir, "NEXT_SESSION.md")).toBe(false);
  } finally {
    fx.cleanup();
  }
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test continuity/tests/gitignore.test.ts`
Expected: 2 new tests FAIL — `Cannot find export 'isFileIgnored' from '../lib/gitignore'`

- [ ] **Step 3: Implement**

Append to `continuity/lib/gitignore.ts`:

```ts
/**
 * `git check-ignore -q <relPath>` returns exit 0 iff the path is gitignored.
 * Returns false on any other exit (including non-git-repo, file not present, etc.).
 */
export function isFileIgnored(projectRoot: string, relPath: string): boolean {
  const r = git(projectRoot, ["check-ignore", "-q", "--", relPath]);
  return r.code === 0;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test continuity/tests/gitignore.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add continuity/lib/gitignore.ts continuity/tests/gitignore.test.ts
git commit -m "continuity: add isFileIgnored helper"
```

---

## Task 4: `isFileTracked` helper

**Files:**
- Modify: `continuity/lib/gitignore.ts` (add `isFileTracked`)
- Modify: `continuity/tests/gitignore.test.ts` (add 2 tests)

- [ ] **Step 1: Append failing tests**

Append to `continuity/tests/gitignore.test.ts`:

```ts
import { isFileTracked } from "../lib/gitignore";

test("isFileTracked returns true for a committed file", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-tracked-true-"));
  const fx = gitInitClean(dir);
  try {
    writeFileSync(join(dir, "NEXT_SESSION.md"), "handoff");
    spawnSync("git", ["add", "NEXT_SESSION.md"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    expect(isFileTracked(dir, "NEXT_SESSION.md")).toBe(true);
  } finally {
    fx.cleanup();
  }
});

test("isFileTracked returns false for an untracked file", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-tracked-false-"));
  const fx = gitInitClean(dir);
  try {
    writeFileSync(join(dir, "NEXT_SESSION.md"), "handoff");
    // Never `git add`ed → untracked
    expect(isFileTracked(dir, "NEXT_SESSION.md")).toBe(false);
  } finally {
    fx.cleanup();
  }
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test continuity/tests/gitignore.test.ts`
Expected: 2 new tests FAIL — `Cannot find export 'isFileTracked' from '../lib/gitignore'`

- [ ] **Step 3: Implement**

Append to `continuity/lib/gitignore.ts`:

```ts
/**
 * `git ls-files --error-unmatch <relPath>` returns exit 0 iff the path is
 * tracked. Returns false on any other exit.
 */
export function isFileTracked(projectRoot: string, relPath: string): boolean {
  const r = git(projectRoot, ["ls-files", "--error-unmatch", "--", relPath]);
  return r.code === 0;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test continuity/tests/gitignore.test.ts`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add continuity/lib/gitignore.ts continuity/tests/gitignore.test.ts
git commit -m "continuity: add isFileTracked helper"
```

---

## Task 5: CLI `--suggest-line` mode

**Files:**
- Modify: `continuity/lib/gitignore.ts` (add CLI entry point)
- Modify: `continuity/tests/gitignore.test.ts` (add 3 tests)

The CLI is invoked by `/wrap` like:

```
bun run continuity/lib/gitignore.ts --suggest-line NEXT_SESSION.md --for-write
```

It prints the suggestion line (or empty) to stdout, exits 0 either way. The 4 conditions for non-empty output (all must hold): `--for-write` was passed, the project is a git repo, the file is not ignored, the file is not tracked.

- [ ] **Step 1: Append failing tests**

Append to `continuity/tests/gitignore.test.ts`:

```ts
const CLI = join(import.meta.dir, "..", "lib", "gitignore.ts");

test("CLI --suggest-line --for-write prints suggestion when all conditions hold", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-cli-emit-"));
  const fx = gitInitClean(dir);
  try {
    writeFileSync(join(dir, "NEXT_SESSION.md"), "handoff");
    // not ignored, not tracked, git repo, --for-write present
    const r = spawnSync("bun", ["run", CLI, "--suggest-line", "NEXT_SESSION.md", "--for-write"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("NEXT_SESSION.md isn't gitignored");
    expect(r.stdout).toContain("stays out of commits");
  } finally {
    fx.cleanup();
  }
});

test("CLI --suggest-line --for-write prints empty when the file is tracked", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-cli-tracked-"));
  const fx = gitInitClean(dir);
  try {
    writeFileSync(join(dir, "NEXT_SESSION.md"), "handoff");
    spawnSync("git", ["add", "NEXT_SESSION.md"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const r = spawnSync("bun", ["run", CLI, "--suggest-line", "NEXT_SESSION.md", "--for-write"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  } finally {
    fx.cleanup();
  }
});

test("CLI --suggest-line without --for-write prints empty regardless", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitignore-cli-nowrite-"));
  const fx = gitInitClean(dir);
  try {
    writeFileSync(join(dir, "NEXT_SESSION.md"), "handoff");
    // Even though all OTHER conditions are met, without --for-write the CLI
    // must remain silent.
    const r = spawnSync("bun", ["run", CLI, "--suggest-line", "NEXT_SESSION.md"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  } finally {
    fx.cleanup();
  }
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test continuity/tests/gitignore.test.ts`
Expected: 3 new tests FAIL — they invoke a CLI that doesn't exist yet (no main block), so output is empty / status non-zero / no expected text.

- [ ] **Step 3: Implement the CLI entry point**

Append to `continuity/lib/gitignore.ts`:

```ts
function isInRepo(projectRoot: string): boolean {
  return git(projectRoot, ["rev-parse", "--is-inside-work-tree"]).code === 0;
}

function suggestLine(projectRoot: string, relPath: string, forWrite: boolean): string {
  if (!forWrite) return "";
  if (!isInRepo(projectRoot)) return "";
  if (isFileIgnored(projectRoot, relPath)) return "";
  if (isFileTracked(projectRoot, relPath)) return "";
  return `  Note: ${relPath} isn't gitignored — consider adding \`${relPath}\` to .gitignore so it stays out of commits.`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--suggest-line");
  if (idx === -1 || argv[idx + 1] === undefined) {
    // Unknown / missing args: stay silent, exit 0. The skill calls us;
    // failing loudly would break /wrap's final report.
    process.exit(0);
  }
  const relPath = argv[idx + 1]!;
  const forWrite = argv.includes("--for-write");
  const line = suggestLine(process.cwd(), relPath, forWrite);
  if (line.length > 0) process.stdout.write(line + "\n");
  process.exit(0);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test continuity/tests/gitignore.test.ts`
Expected: 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add continuity/lib/gitignore.ts continuity/tests/gitignore.test.ts
git commit -m "continuity: add --suggest-line CLI mode to gitignore.ts"
```

---

## Task 6: session-start.ts — dotdir skip

**Files:**
- Modify: `continuity/hooks/session-start.ts`
- Modify: `continuity/tests/session-start.test.ts` (add 1 test)

- [ ] **Step 1: Append failing test**

Append to `continuity/tests/session-start.test.ts`:

```ts
test("scanForNextSessions skips dotdirs (e.g., .cache)", () => {
  const root = mkdtempSync(join(tmpdir(), "scan-dotdir-"));
  mkdirSync(join(root, ".cache"));
  // A handoff in a dotdir must NOT be found.
  writeFileSync(join(root, ".cache", "NEXT_SESSION.md"), "should be skipped");
  // A handoff at the visible root MUST be found.
  writeFileSync(join(root, "NEXT_SESSION.md"), "should be found");
  const found = scanForNextSessions(root);
  const paths = found.map((f) => f.path);
  expect(paths).toContain(join(root, "NEXT_SESSION.md"));
  expect(paths).not.toContain(join(root, ".cache", "NEXT_SESSION.md"));
});
```

Note: the existing test file already imports `scanForNextSessions` and the relevant `node:fs` / `node:path` helpers. If it doesn't, add the import line `import { scanForNextSessions } from "../hooks/session-start";` (read the file first to confirm).

- [ ] **Step 2: Run, verify failure**

Run: `bun test continuity/tests/session-start.test.ts`
Expected: new test FAILS — current `scanForNextSessions` only skips entries from a small `IGNORE_DIRS` set (`.git`, `.venv`), so `.cache/NEXT_SESSION.md` is found and the assertion `not.toContain` fails.

- [ ] **Step 3: Implement the dotdir skip**

In `continuity/hooks/session-start.ts`, locate the walk function inside `scanForNextSessions`. The current walk inspects each directory entry — modify it so any directory whose name starts with `.` is pruned (in addition to the existing `IGNORE_DIRS` check). Concretely, in the inner `for (const e of entries)` loop, replace:

```ts
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if ...
```

with:

```ts
      if (e.isDirectory()) {
        // Cheap-first pruning (per project invariant on ordering): name-based
        // checks happen before any absolute-path allocation.
        if (e.name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if ...
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test continuity/tests/session-start.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add continuity/hooks/session-start.ts continuity/tests/session-start.test.ts
git commit -m "continuity: skip dotdirs in SessionStart scan"
```

---

## Task 7: session-start.ts — gitignored-dir skip

**Files:**
- Modify: `continuity/hooks/session-start.ts`
- Modify: `continuity/tests/session-start.test.ts` (add 3 tests)

- [ ] **Step 1: Append failing tests**

Append to `continuity/tests/session-start.test.ts`:

```ts
import { gitInitClean } from "./helpers/git";

test("scanForNextSessions skips a gitignored directory", () => {
  const root = mkdtempSync(join(tmpdir(), "scan-ignored-dir-"));
  const fx = gitInitClean(root);
  try {
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "NEXT_SESSION.md"), "inside ignored dir");
    writeFileSync(join(root, "NEXT_SESSION.md"), "at root");
    const found = scanForNextSessions(root);
    const paths = found.map((f) => f.path);
    expect(paths).toContain(join(root, "NEXT_SESSION.md"));
    expect(paths).not.toContain(join(root, "dist", "NEXT_SESSION.md"));
  } finally {
    fx.cleanup();
  }
});

test("scanForNextSessions still finds a gitignored NEXT_SESSION.md at root", () => {
  // The filter prunes ignored *directories*, not ignored *files*. A handoff
  // file that's gitignored at root must still be surfaced.
  const root = mkdtempSync(join(tmpdir(), "scan-ignored-file-"));
  const fx = gitInitClean(root);
  try {
    writeFileSync(join(root, ".gitignore"), "NEXT_SESSION.md\n");
    writeFileSync(join(root, "NEXT_SESSION.md"), "should still be found");
    const found = scanForNextSessions(root);
    expect(found.map((f) => f.path)).toContain(join(root, "NEXT_SESSION.md"));
  } finally {
    fx.cleanup();
  }
});

test("scanForNextSessions does NOT find NEXT_SESSION.md inside a gitignored dir", () => {
  // Acknowledged edge case from the spec: if a user keeps a handoff inside
  // a gitignored directory, the dir-prune skips it. Locking the behavior in.
  const root = mkdtempSync(join(tmpdir(), "scan-handoff-in-ignored-"));
  const fx = gitInitClean(root);
  try {
    writeFileSync(join(root, ".gitignore"), "coverage/\n");
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage", "NEXT_SESSION.md"), "inside ignored dir");
    const found = scanForNextSessions(root);
    expect(found).toEqual([]);
  } finally {
    fx.cleanup();
  }
});
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test continuity/tests/session-start.test.ts`
Expected: the new "skips a gitignored directory" and "does NOT find NEXT_SESSION.md inside a gitignored dir" tests FAIL (the current implementation has no gitignore awareness so it traverses `dist/` and `coverage/`). The "still finds at root" test may PASS by accident with the dotdir filter alone — leave it as a regression guard.

- [ ] **Step 3: Implement gitignored-dir skip**

In `continuity/hooks/session-start.ts`:

(a) Add the import at the top (alongside the existing imports):

```ts
import { getIgnoredDirs } from "../lib/gitignore";
```

(b) Modify `scanForNextSessions` to compute the ignored Set once and pass it through the walk:

```ts
export function scanForNextSessions(root: string, maxDepth = MAX_DEPTH): NextSessionFile[] {
  const out: NextSessionFile[] = [];
  const ignored = getIgnoredDirs(root);
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // Cheap-first ordering: name-based checks before the absolute-path
        // Set lookup, which involves the `full` string we already built but
        // would otherwise want to avoid for skipped dirs.
        if (e.name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(e.name)) continue;
        if (ignored.has(full)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && e.name === "NEXT_SESSION.md") {
        try {
          const st = statSync(full);
          out.push({ path: full, mtimeMs: st.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(root, 0);
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test continuity/tests/session-start.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add continuity/hooks/session-start.ts continuity/tests/session-start.test.ts
git commit -m "continuity: honor .gitignore for directory pruning in scan"
```

---

## Task 8: session-start.ts — timing wrap and slow-note suffix

**Files:**
- Modify: `continuity/hooks/session-start.ts`
- Modify: `continuity/tests/session-start.test.ts` (add 2 tests)

The slow-note is **suffix-only**: appended to an existing non-null banner. When `buildBanner` returns `null` (no handoffs), the banner stays `{}` even if the scan was slow. The threshold defaults to 500 ms and is overridable via the `CONTINUITY_SLOW_MS` env var. The walker also tracks per-toplevel-dir walk counts so the suffix can name the heaviest contributors.

- [ ] **Step 1: Append failing tests**

Append to `continuity/tests/session-start.test.ts`:

```ts
test("slow-scan suffix appears when CONTINUITY_SLOW_MS=0 forces it (and a handoff is present)", () => {
  const root = mkdtempSync(join(tmpdir(), "scan-slow-suffix-"));
  // Create some directories that get walked so 'top:' has something to name.
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "src", "a"));
  mkdirSync(join(root, "src", "b"));
  writeFileSync(join(root, "NEXT_SESSION.md"), "handoff");
  const res = spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, CONTINUITY_SLOW_MS: "0" },
  });
  const json = JSON.parse(res.stdout);
  expect(json.systemMessage).toContain("Continuity:");
  expect(json.systemMessage).toContain("(slow scan:");
  expect(json.systemMessage).toContain("dirs · top:");
  expect(json.systemMessage).toMatch(/top: \.\/\S+ \d+ dirs/);
});

test("slow scan with no handoffs still emits {} (suffix-only invariant)", () => {
  const root = mkdtempSync(join(tmpdir(), "scan-slow-empty-"));
  mkdirSync(join(root, "src"));
  // No NEXT_SESSION.md anywhere.
  const res = spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, CONTINUITY_SLOW_MS: "0" },
  });
  expect(res.status).toBe(0);
  expect(res.stdout.trim()).toBe("{}");
});
```

Note: the existing test file already has the `SCRIPT` constant pointing at `hooks/session-start.ts` and uses `spawnSync` against it. If those aren't present in your version, add at the top:

```ts
import { spawnSync } from "node:child_process";
const SCRIPT = join(import.meta.dir, "..", "hooks", "session-start.ts");
```

- [ ] **Step 2: Run, verify failure**

Run: `bun test continuity/tests/session-start.test.ts`
Expected: 2 new tests FAIL — the current code has no timing logic, so no `(slow scan:` suffix appears.

- [ ] **Step 3: Implement timing wrap, walk counter, slow-note suffix**

In `continuity/hooks/session-start.ts`:

(a) Extend `scanForNextSessions` to track per-toplevel walks AND elapsed time, and return both alongside the file list. Replace the current export with:

```ts
export type ScanResult = {
  files: NextSessionFile[];
  elapsedMs: number;
  /** Per-toplevel-segment walk counts (subdirs entered under that toplevel). */
  walks: Map<string, number>;
};

export function scanForNextSessions(root: string, maxDepth = MAX_DEPTH): NextSessionFile[] {
  return scanForNextSessionsWithStats(root, maxDepth).files;
}

export function scanForNextSessionsWithStats(root: string, maxDepth = MAX_DEPTH): ScanResult {
  const out: NextSessionFile[] = [];
  const ignored = getIgnoredDirs(root);
  const walks = new Map<string, number>();
  const start = performance.now();
  function walk(dir: string, depth: number, topLevel: string | null) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(e.name)) continue;
        if (ignored.has(full)) continue;
        const nextTop = topLevel ?? e.name;
        walks.set(nextTop, (walks.get(nextTop) ?? 0) + 1);
        walk(full, depth + 1, nextTop);
      } else if (e.isFile() && e.name === "NEXT_SESSION.md") {
        try {
          const st = statSync(full);
          out.push({ path: full, mtimeMs: st.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(root, 0, null);
  return { files: out, elapsedMs: performance.now() - start, walks };
}
```

The `scanForNextSessions` overload is kept (it just unwraps `files`) so the existing tests and any external callers continue to work.

(b) Add a helper that formats the slow-note suffix:

```ts
function formatSlowNote(elapsedMs: number, walks: Map<string, number>): string {
  const totalDirs = Array.from(walks.values()).reduce((a, b) => a + b, 0);
  // Top 2 contributors by walk count.
  const top = Array.from(walks.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, n]) => `./${name} ${n} dirs`)
    .join(", ");
  const secs = (elapsedMs / 1000).toFixed(1);
  const topClause = top.length > 0 ? ` · top: ${top}` : "";
  return ` (slow scan: ${secs}s · ${totalDirs} dirs${topClause})`;
}
```

(c) Update the `import.meta.main` block to use the new stats variant and append the suffix when slow + non-null banner:

```ts
if (import.meta.main) {
  try {
    const sessionCwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const projectRoot = findProjectRoot(sessionCwd);
    const { files, elapsedMs, walks } = scanForNextSessionsWithStats(projectRoot);
    const banner = buildBanner({ sessionCwd, projectRoot, files });
    debugLog(`cwd=${sessionCwd} root=${projectRoot} files=${files.length} elapsedMs=${elapsedMs.toFixed(1)} emit=${banner === null ? "empty" : "banner"}`);
    if (banner === null) {
      process.stdout.write("{}\n");
    } else {
      const slowMsRaw = Number.parseInt(process.env.CONTINUITY_SLOW_MS ?? "500", 10);
      const slowMs = Number.isFinite(slowMsRaw) ? slowMsRaw : 500;
      const withNote = elapsedMs > slowMs
        ? banner + formatSlowNote(elapsedMs, walks)
        : banner;
      process.stdout.write(JSON.stringify({ systemMessage: withNote }) + "\n");
    }
    process.exit(0);
  } catch (e) {
    debugLog(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.stdout.write("{}\n");
    process.exit(0);
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `bun test continuity/tests/session-start.test.ts`
Expected: all pass (existing + new).

Run the full continuity suite for safety: `bun test continuity/`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add continuity/hooks/session-start.ts continuity/tests/session-start.test.ts
git commit -m "continuity: time SessionStart scan, emit slow-note suffix"
```

---

## Task 9: wrap/SKILL.md — write-path suggestion call + final-report line

**Files:**
- Modify: `continuity/skills/wrap/SKILL.md`

No automated test for the skill prose (it's procedural Markdown). The CLI behavior it depends on is fully tested in Task 5.

- [ ] **Step 1: Read the current SKILL.md**

Open `continuity/skills/wrap/SKILL.md`. The file has numbered procedure sections; Section 5 ("NEXT_SESSION.md lifecycle") needs a new sub-step on the write path, and Section 7 ("Final report") needs to include the suggestion line in its output block.

- [ ] **Step 2: In Section 5, add a new sub-step after the merged file is written**

Section 5 step 3 is "Build the new file" and step 4 is "Decide write vs remove". After whichever sub-step writes the file to disk, insert a new sub-step:

```markdown
6. **(Write path only) Capture a gitignore suggestion for the final report.** This step runs ONLY when this invocation actually wrote `NEXT_SESSION.md` — not when it was preserved-user-edited (step 1), removed (step 4 → empty), or absent (step 5). On the write path:

   ```bash
   SUGGEST=$(bun run "<skill-base-dir>/../../lib/gitignore.ts" --suggest-line NEXT_SESSION.md --for-write)
   ```

   On all other paths, leave `SUGGEST` empty (`SUGGEST=""`) or skip the call entirely. Calling without `--for-write` also returns empty — both forms are safe no-ops.
```

(Renumber any subsequent steps in Section 5 to accommodate, if applicable.)

- [ ] **Step 3: In Section 7 (Final report), splice `$SUGGEST` into the output template**

The existing template ends with the four `NEXT_SESSION` / `CLAUDE.md` lines. Append `$SUGGEST` as a conditional final line:

```markdown
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
```

- [ ] **Step 4: Verify the SKILL.md change by exercising the CLI flow manually**

Set up a quick fixture and exercise both branches by hand. From the repo root:

```bash
# Write path with conditions met → suggestion expected
TMPDIR_TEST=$(mktemp -d)
cd "$TMPDIR_TEST"
git init -q -b main
git config user.email t@e
git config user.name t
git config commit.gpgsign false
echo "handoff" > NEXT_SESSION.md
bun run /Volumes/chonk/projects/enfurbish/continuity/lib/gitignore.ts --suggest-line NEXT_SESSION.md --for-write
# Expected: prints a "Note: NEXT_SESSION.md isn't gitignored..." line.

# Without --for-write → empty
bun run /Volumes/chonk/projects/enfurbish/continuity/lib/gitignore.ts --suggest-line NEXT_SESSION.md
# Expected: prints nothing.

# Tracked → empty
git add NEXT_SESSION.md && git commit -q -m s
bun run /Volumes/chonk/projects/enfurbish/continuity/lib/gitignore.ts --suggest-line NEXT_SESSION.md --for-write
# Expected: prints nothing.

cd - && rm -rf "$TMPDIR_TEST"
```

All three commands must behave as expected before committing.

- [ ] **Step 5: Commit**

```bash
git add continuity/skills/wrap/SKILL.md
git commit -m "continuity: /wrap suggests gitignoring NEXT_SESSION.md on the write path"
```

---

## Task 10: README + plugin.json version bump

**Files:**
- Modify: `continuity/README.md`
- Modify: `continuity/.claude-plugin/plugin.json`

- [ ] **Step 1: Update `continuity/README.md`**

Add a short paragraph describing the new scan behavior. Find the section that documents the SessionStart hook (likely titled "## How it works" or similar) and append:

```markdown
The scan prunes hidden directories (any name starting with `.`) and gitignored directories (via one `git ls-files --others --ignored --exclude-standard --directory -z` call at scan start). A gitignored *file* named `NEXT_SESSION.md` is still surfaced — only directories are pruned. When the scan exceeds `CONTINUITY_SLOW_MS` milliseconds (default 500), the banner gains a suffix naming the heaviest top-level directories walked, so you know what to add to `.gitignore`. The suffix is only appended when there is otherwise a banner to emit — a slow scan with no handoffs stays silent.

`/wrap` adds one more nicety: when it writes `NEXT_SESSION.md` in a git repo and the file is neither in `.gitignore` nor already tracked, the final report prints a single-line suggestion to gitignore it. The skill never edits `.gitignore` — it just suggests.
```

(Find the most natural insertion point; if there's a "Hook behavior" or "Scan" subsection use that, otherwise after the existing How-it-works paragraph.)

- [ ] **Step 2: Bump the plugin version**

In `continuity/.claude-plugin/plugin.json`, change:

```json
  "version": "0.2.1",
```

to:

```json
  "version": "0.3.0",
```

(Per `RELEASING.md`: new behaviors → minor bump.)

- [ ] **Step 3: Run the full test suite as a sanity check**

Run: `bun test`
Expected: all tests pass (continuity additions plus the pre-existing affirm + continuity tests).

- [ ] **Step 4: Commit**

```bash
git add continuity/README.md continuity/.claude-plugin/plugin.json
git commit -m "continuity: bump to 0.3.0 (scan filtering, slow-note, gitignore suggestion)"
```

---

## Task 11: Final full-suite verification + smoke tests

- [ ] **Step 1: Full bun test**

Run: `bun test`
Expected: all tests pass. Compare counts to the start-of-feature baseline (we'd expect ~70 + 4 + 2 + 2 + 3 + 1 + 3 + 2 = ~87 new test additions land cleanly; minor variance is fine).

- [ ] **Step 2: Smoke the hook against a real fixture**

```bash
TMPDIR_TEST=$(mktemp -d)
cd "$TMPDIR_TEST"
mkdir -p src/a src/b coverage
echo "handoff" > NEXT_SESSION.md
echo "should be ignored" > coverage/NEXT_SESSION.md
# Simulate a git repo with coverage/ ignored
git init -q -b main
git config user.email t@e
git config user.name t
echo "coverage/" > .gitignore

CLAUDE_PROJECT_DIR="$TMPDIR_TEST" bun run /Volumes/chonk/projects/enfurbish/continuity/hooks/session-start.ts
# Expected stdout: JSON containing a Continuity: banner that mentions NEXT_SESSION.md
# at root and does NOT mention coverage/NEXT_SESSION.md.

# Force slow path
CLAUDE_PROJECT_DIR="$TMPDIR_TEST" CONTINUITY_SLOW_MS=0 bun run /Volumes/chonk/projects/enfurbish/continuity/hooks/session-start.ts
# Expected: same banner, now with a "(slow scan: 0.0s · N dirs · top: ...)" suffix.

cd - && rm -rf "$TMPDIR_TEST"
```

- [ ] **Step 3: Smoke the CLI**

```bash
bun run continuity/lib/gitignore.ts --suggest-line NEXT_SESSION.md
# Expected: empty output (no --for-write).
bun run continuity/lib/gitignore.ts --suggest-line NEXT_SESSION.md --for-write
# Expected (in this repo): empty (NEXT_SESSION.md is in this project's .gitignore already).
```

- [ ] **Step 4: Stray-marker scan**

Run: `grep -rn "TODO\|XXX\|FIXME" continuity/ | grep -v node_modules || true`
Expected: empty (no new TODO markers introduced by this work).

- [ ] **Step 5: Confirm clean tree**

Run: `git status`
Expected: clean working tree. If anything's still pending from earlier tasks, commit it now with an appropriate message.

---

## Self-review checklist

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| `getIgnoredDirs` (returns Set, trailing-`/` filter, nested .gitignore) | Task 2 |
| `isFileIgnored` | Task 3 |
| `isFileTracked` | Task 4 |
| `--suggest-line` CLI mode with `--for-write` discipline | Task 5 |
| Session-start dotdir skip | Task 6 |
| Session-start gitignored-dir skip + still finds gitignored-file-at-root + edge-case "inside ignored dir" | Task 7 |
| Pruning-check order (name → IGNORE_DIRS → Set) | Tasks 6, 7 (encoded inline in the patches) |
| Timing wrap + slow-note suffix with `N dirs` notation | Task 8 |
| Suffix-only invariant (no standalone slow banner) | Task 8 |
| `CONTINUITY_SLOW_MS` env (default 500) | Task 8 |
| `/wrap` Section 5 write-path call | Task 9 |
| `/wrap` Section 7 final-report splice | Task 9 |
| README documentation | Task 10 |
| Minor version bump → 0.3.0 | Task 10 |
| Fixture isolation (GIT_CONFIG_NOSYSTEM=1, HOME/XDG_CONFIG_HOME overrides) | Task 1; used in Tasks 2–5, 7 |
| `node:child_process.spawnSync(..., { timeout: 5000 })` (NOT `Bun.spawn`) | Tasks 2, 3, 4 (encoded in `git()` helper); Task 1 fixture uses node:child_process too |

No spec requirements unaddressed.

**2. Placeholder scan:** No "TBD", no "implement later", no "similar to Task N." Every code block is complete and pastable. Every file path is absolute or relative-from-repo-root.

**3. Type consistency:** `getIgnoredDirs` returns `Set<string>` everywhere consumed (Task 7 walker, Task 5 CLI's `isInRepo`+`isFileIgnored`+`isFileTracked` composition, never reads via index/Map). `isFileIgnored` / `isFileTracked` both return `boolean`. `ScanResult` type defined in Task 8 and consumed only there. `formatSlowNote` signature matches its single call site. `GitFixture` exposes only `cleanup: () => void` and is consumed identically in every test (`const fx = gitInitClean(dir); try { ... } finally { fx.cleanup(); }`).
