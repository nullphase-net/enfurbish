# Affirm CLI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the affirm CLI's "bare invocation records hashes" semantics with explicit `-a`/`--apply` and `-r`/`--revoke` flags. Make bare `/affirm` a read-only details view (status + mtime + git author). Drop the redundant `--show`. Prefix the SessionStart banner with the plugin name. Collapse the `/affirm` skill to a thin CLI pass-through.

**Architecture:** All logic stays in TypeScript libs under `affirm/lib/`. A new `file-meta.ts` provides `getMtime` and `getGitInfo` helpers consumed by the CLI's details mode. The CLI becomes flag-driven; the skill no longer prompts the user (it just forwards args and relays output). The SessionStart hook prefixes its banner with `Affirm:` to match the convention `continuity` already uses.

**Tech Stack:** Bun, TypeScript, `bun:test`, `node:child_process.spawnSync` for git lookups.

**TODO items addressed:** #2 (name self in SessionStart), #3 (no confirmation gate — `-a` is the attestation), #4 (mtime), #5 (git status/author), #9 (deterministic — skill has no LLM-in-the-loop steps).

**TODO items deferred:** #1 (relative-time deltas) — cross-cutting across both plugins; will be applied uniformly later. For now, render ISO 8601 timestamps. #6, #7, #8 — continuity-side, separate plan.

---

## CLI Surface (final)

```
affirm                 details: status + mtime + git info (read-only)
affirm -a | --apply    record current hashes (the attestation)
affirm -r | --revoke   drop this project's affirmations
affirm -h | --help     usage
```

- `--show` removed (bare invocation replaces it).
- `-a` and `-r` are mutually exclusive — passing both exits 2 with usage.
- Unknown flags exit 2 with usage (unchanged).
- Exit 0 when no instruction files are present (unchanged).

## Banner format (session-start)

Only change: prefix `Affirm:` on the first line. Everything else unchanged.

```
Affirm: instruction files in this project:
  ✓ CLAUDE.md
  ✦ .claude/rules/style.md  [NEW — unaffirmed]
  ✧ .claude/rules/security.md  [CHANGED — unaffirmed]

⚠ Review unaffirmed files, then run /affirm.
```

## Details output format

```
Instruction files in /path/to/project:

  CLAUDE.md
    status:   CHANGED (hash mismatch)
    modified: 2026-05-22T10:14:32Z
    git:      Alice Doe — last commit 2026-05-20T09:01:11Z (uncommitted local changes)

  .claude/rules/style.md
    status:   affirmed
    modified: 2026-04-10T09:01:11Z
    git:      Bob — last commit 2026-04-10T09:00:00Z

Run /affirm -a to record current hashes, /affirm -r to revoke.
```

- `git:` line is omitted when the file is untracked or the project isn't a git repo.
- `(uncommitted local changes)` suffix appears when working-tree shows the file as modified.

---

## File Structure

**New:**
- `affirm/lib/file-meta.ts` — `getMtime(path)`, `getGitInfo(projectDir, filePath)`.
- `affirm/tests/file-meta.test.ts` — unit tests for both helpers, including a git-init fixture.

**Modified:**
- `affirm/lib/cli.ts` — rewrite arg parsing; bare → details; `-a`/`--apply` → record; `-r`/`--revoke` → revoke; drop `--show`; reject `-a -r`.
- `affirm/hooks/session-start.ts` — prefix banner with `Affirm: `.
- `affirm/skills/affirm/SKILL.md` — collapse to thin pass-through.
- `affirm/tests/cli.test.ts` — overhauled to match new surface.
- `affirm/tests/session-start.test.ts` — assert `Affirm:` prefix.
- `affirm/README.md` — refresh banner-format example, commands, direct-CLI section.
- `CLAUDE.md` (project root) — update example commands.

**Unchanged:**
- `affirm/lib/affirm.ts` — library API stable.
- `affirm/tests/affirm.test.ts`.
- `affirm/hooks/hooks.json`, `affirm/.claude-plugin/plugin.json`.

---

## Task 1: `getMtime` helper

**Files:**
- Create: `affirm/lib/file-meta.ts`
- Test: `affirm/tests/file-meta.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `affirm/tests/file-meta.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMtime } from "../lib/file-meta";

test("getMtime returns the file's mtime in milliseconds", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-meta-"));
  const f = join(dir, "x.txt");
  writeFileSync(f, "hi");
  // Set mtime to a known epoch second
  utimesSync(f, 1715000000, 1715000000);
  expect(getMtime(f)).toBe(1715000000 * 1000);
});

test("getMtime returns null for missing files", () => {
  expect(getMtime("/no/such/file/anywhere")).toBeNull();
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test affirm/tests/file-meta.test.ts`
Expected: FAIL with `Cannot find module '../lib/file-meta'`.

- [ ] **Step 3: Implement the helper**

Create `affirm/lib/file-meta.ts`:

```ts
import { statSync } from "node:fs";

export function getMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test affirm/tests/file-meta.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add affirm/lib/file-meta.ts affirm/tests/file-meta.test.ts
git commit -m "affirm: add getMtime helper for file-meta module"
```

---

## Task 2: `getGitInfo` helper

**Files:**
- Modify: `affirm/lib/file-meta.ts` (add `getGitInfo` + `GitInfo` type)
- Modify: `affirm/tests/file-meta.test.ts` (add 4 tests)

- [ ] **Step 1: Write the failing tests**

Append to `affirm/tests/file-meta.test.ts`:

```ts
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { getGitInfo } from "../lib/file-meta";

function gitInit(dir: string) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

test("getGitInfo returns inRepo=false outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-meta-nogit-"));
  writeFileSync(join(dir, "x.md"), "hi");
  const info = getGitInfo(dir, join(dir, "x.md"));
  expect(info.inRepo).toBe(false);
  expect(info.lastCommit).toBeNull();
  expect(info.dirty).toBe(false);
});

test("getGitInfo returns lastCommit for a tracked, clean file", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-meta-clean-"));
  gitInit(dir);
  const f = join(dir, "x.md");
  writeFileSync(f, "v1");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const info = getGitInfo(dir, f);
  expect(info.inRepo).toBe(true);
  expect(info.lastCommit?.author).toBe("Test User");
  expect(info.lastCommit?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(info.dirty).toBe(false);
});

test("getGitInfo flags dirty when the file has uncommitted changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-meta-dirty-"));
  gitInit(dir);
  const f = join(dir, "x.md");
  writeFileSync(f, "v1");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  writeFileSync(f, "v2");
  const info = getGitInfo(dir, f);
  expect(info.inRepo).toBe(true);
  expect(info.dirty).toBe(true);
});

test("getGitInfo returns lastCommit=null for untracked file in a repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-meta-untracked-"));
  gitInit(dir);
  // Create an initial commit so HEAD exists
  writeFileSync(join(dir, "seed.md"), "seed");
  spawnSync("git", ["add", "seed.md"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  // Now add an untracked file
  const f = join(dir, "untracked.md");
  writeFileSync(f, "x");
  const info = getGitInfo(dir, f);
  expect(info.inRepo).toBe(true);
  expect(info.lastCommit).toBeNull();
  expect(info.dirty).toBe(true);  // untracked counts as dirty in working tree
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test affirm/tests/file-meta.test.ts`
Expected: FAIL with `Cannot find export 'getGitInfo' from '../lib/file-meta'`.

- [ ] **Step 3: Implement the helper**

Add to `affirm/lib/file-meta.ts`:

```ts
import { spawnSync } from "node:child_process";

export type GitInfo = {
  inRepo: boolean;
  lastCommit: { author: string; date: string } | null;
  dirty: boolean;
};

function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
}

export function getGitInfo(projectDir: string, filePath: string): GitInfo {
  const inRepo = git(projectDir, ["rev-parse", "--is-inside-work-tree"]).code === 0;
  if (!inRepo) return { inRepo: false, lastCommit: null, dirty: false };

  const log = git(projectDir, ["log", "-1", "--format=%an%n%aI", "--", filePath]);
  let lastCommit: GitInfo["lastCommit"] = null;
  if (log.code === 0 && log.stdout.trim().length > 0) {
    const [author, date] = log.stdout.trim().split("\n");
    if (author && date) lastCommit = { author, date };
  }

  const status = git(projectDir, ["status", "--porcelain", "--", filePath]);
  const dirty = status.code === 0 && status.stdout.trim().length > 0;

  return { inRepo, lastCommit, dirty };
}
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test affirm/tests/file-meta.test.ts`
Expected: 6 pass total.

- [ ] **Step 5: Commit**

```bash
git add affirm/lib/file-meta.ts affirm/tests/file-meta.test.ts
git commit -m "affirm: add getGitInfo helper for file-meta module"
```

---

## Task 3: Add `-a`/`--apply` and short `-r` (additive, non-breaking)

This adds the new flags without removing existing behavior, so the rest of the test suite still passes.

**Files:**
- Modify: `affirm/lib/cli.ts`
- Modify: `affirm/tests/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `affirm/tests/cli.test.ts`:

```ts
test("-a records hashes (same behavior as bare invocation today)", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const io = collect();
  const code = runCli(["-a"], opts(dir, hashPath, io));
  expect(code).toBe(0);
  expect(io.out.join("\n")).toContain("Affirmed 1 file");
  expect(loadHashes(hashPath)[join(dir, "CLAUDE.md")]).toBe(sha256OfFile(join(dir, "CLAUDE.md")));
});

test("--apply records hashes (long form of -a)", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const io = collect();
  const code = runCli(["--apply"], opts(dir, hashPath, io));
  expect(code).toBe(0);
  expect(io.out.join("\n")).toContain("Affirmed 1 file");
});

test("-r revokes (short form of --revoke)", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  saveHashes({ [join(dir, "CLAUDE.md")]: sha256OfFile(join(dir, "CLAUDE.md")) }, hashPath);
  const io = collect();
  const code = runCli(["-r"], opts(dir, hashPath, io));
  expect(code).toBe(0);
  expect(io.out.join("\n")).toContain("Revoked 1 affirmation");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test affirm/tests/cli.test.ts`
Expected: 3 new tests FAIL with "Unknown argument: -a" / "Unknown argument: --apply" / "Unknown argument: -r".

- [ ] **Step 3: Implement**

In `affirm/lib/cli.ts`, expand the flag handling. Replace the existing `arg === "--revoke"` block with:

```ts
  if (arg === "--revoke" || arg === "-r") {
    const { revoked } = revokeProject(projectDir, hashPath);
    if (revoked.length === 0) {
      opts.out(`No prior affirmations to revoke in ${projectDir}.`);
    } else {
      opts.out(`Revoked ${revoked.length} affirmation${revoked.length === 1 ? "" : "s"} in ${projectDir}:`);
      for (const f of revoked) opts.out(`  ${relative(projectDir, f)}`);
      opts.out("");
      opts.out("Next session will surface these as unaffirmed.");
    }
    return 0;
  }
```

And replace the existing "unknown argument" guard + bare-invocation approveAll block with:

```ts
  if (arg === "-a" || arg === "--apply" || arg === undefined || arg === "affirm") {
    const { approved } = approveAll(projectDir, hashPath);
    opts.out(`Affirmed ${approved.length} file${approved.length === 1 ? "" : "s"} in ${projectDir}:`);
    for (const { path, hash } of approved) {
      opts.out(`  ${relative(projectDir, path)}  (${hash.slice(0, 12)}…)`);
    }
    return 0;
  }

  opts.err(`Unknown argument: ${arg}\n\n${usage()}`);
  return 2;
```

(`undefined` / `"affirm"` are kept here only until Task 4 swaps the bare default to details mode.)

Update `usage()` to mention the new flags:

```ts
function usage(): string {
  return [
    "Usage:",
    "  affirm                show status, mtime, and git info for instruction files in cwd",
    "  affirm -a, --apply    record SHA-256 hashes (the attestation)",
    "  affirm -r, --revoke   remove affirmation for files in cwd",
    "  affirm --show         (deprecated alias for bare invocation)",
    "  affirm --help         show this message",
  ].join("\n");
}
```

(Final usage updated again in Task 4 once `--show` is gone and bare = details.)

- [ ] **Step 4: Run and verify pass**

Run: `bun test affirm/tests/cli.test.ts`
Expected: all tests pass (existing + new 3).

- [ ] **Step 5: Commit**

```bash
git add affirm/lib/cli.ts affirm/tests/cli.test.ts
git commit -m "affirm: add -a/--apply and -r short flags (additive)"
```

---

## Task 4: Switch bare to details mode, drop `--show`

This is the breaking change. Bare invocation no longer records — it shows details. `--show` is removed (now redundant).

**Files:**
- Modify: `affirm/lib/cli.ts`
- Modify: `affirm/tests/cli.test.ts`

- [ ] **Step 1: Rewrite affected tests**

In `affirm/tests/cli.test.ts`, replace the existing `"no-arg (affirm) records hashes..."` test with:

```ts
test("bare invocation shows details, records nothing", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const io = collect();
  const code = runCli([], opts(dir, hashPath, io));
  expect(code).toBe(0);
  const out = io.out.join("\n");
  expect(out).toContain("Instruction files in");
  expect(out).toContain("CLAUDE.md");
  expect(out).toMatch(/status:\s+NEW \(not yet affirmed\)/);
  expect(out).toMatch(/modified:\s+\d{4}-\d{2}-\d{2}T/);
  expect(out).toContain("/affirm -a");  // hint footer
  // Nothing recorded
  expect(loadHashes(hashPath)).toEqual({});
});

test("bare invocation shows affirmed status for matching hash", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  saveHashes({ [join(dir, "CLAUDE.md")]: sha256OfFile(join(dir, "CLAUDE.md")) }, hashPath);
  const io = collect();
  runCli([], opts(dir, hashPath, io));
  expect(io.out.join("\n")).toMatch(/status:\s+affirmed/);
});

test("bare invocation flags CHANGED after file mutation", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "v1");
  saveHashes({ [join(dir, "CLAUDE.md")]: sha256OfFile(join(dir, "CLAUDE.md")) }, hashPath);
  writeFileSync(join(dir, "CLAUDE.md"), "v2");
  const io = collect();
  runCli([], opts(dir, hashPath, io));
  expect(io.out.join("\n")).toContain("CHANGED (hash mismatch)");
});

test("--show is no longer recognized", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const io = collect();
  const code = runCli(["--show"], opts(dir, hashPath, io));
  expect(code).toBe(2);
  expect(io.err.join("\n")).toContain("Unknown argument: --show");
});
```

Also remove the two existing `--show` tests (`"--show reports NEW..."` and `"--show reports CHANGED..."`) — that flag is gone.

- [ ] **Step 2: Run and verify failure**

Run: `bun test affirm/tests/cli.test.ts`
Expected: new tests FAIL (bare still records; `--show` still works).

- [ ] **Step 3: Implement details mode**

In `affirm/lib/cli.ts`:

(a) Add imports at the top:

```ts
import { getMtime, getGitInfo, type GitInfo } from "./file-meta";
```

(b) Add a `details` renderer before `runCli`:

```ts
function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fmtGit(info: GitInfo): string | null {
  if (!info.inRepo) return null;
  if (!info.lastCommit) {
    return info.dirty ? "untracked (uncommitted)" : "untracked";
  }
  const base = `${info.lastCommit.author} — last commit ${info.lastCommit.date}`;
  return info.dirty ? `${base} (uncommitted local changes)` : base;
}

function renderDetails(projectDir: string, files: string[], stored: Record<string, string>, out: (s: string) => void) {
  out(`Instruction files in ${projectDir}:`);
  out("");
  for (const f of files) {
    out(`  ${relative(projectDir, f)}`);
    out(`    status:   ${statusOf(f, stored)}`);
    const mt = getMtime(f);
    if (mt !== null) out(`    modified: ${fmtTs(mt)}`);
    const git = fmtGit(getGitInfo(projectDir, f));
    if (git !== null) out(`    git:      ${git}`);
    out("");
  }
  out("Run /affirm -a to record current hashes, /affirm -r to revoke.");
}
```

(c) Replace the dispatch block to make bare → details and remove `--show`:

```ts
  // --show no longer exists; falls through to unknown-arg.

  if (arg === "-a" || arg === "--apply") {
    const { approved } = approveAll(projectDir, hashPath);
    opts.out(`Affirmed ${approved.length} file${approved.length === 1 ? "" : "s"} in ${projectDir}:`);
    for (const { path, hash } of approved) {
      opts.out(`  ${relative(projectDir, path)}  (${hash.slice(0, 12)}…)`);
    }
    return 0;
  }

  if (arg === undefined) {
    renderDetails(projectDir, files, loadHashes(hashPath), opts.out);
    return 0;
  }

  opts.err(`Unknown argument: ${arg}\n\n${usage()}`);
  return 2;
```

(d) Update `usage()`:

```ts
function usage(): string {
  return [
    "Usage:",
    "  affirm                show status, mtime, and git info for instruction files in cwd",
    "  affirm -a, --apply    record SHA-256 hashes (the attestation)",
    "  affirm -r, --revoke   remove affirmation for files in cwd",
    "  affirm -h, --help     show this message",
  ].join("\n");
}
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test affirm/tests/cli.test.ts`
Expected: all pass.

Run the full suite: `bun test`
Expected: all pass (affirm.test.ts unchanged, file-meta tests pass, cli tests pass, session-start unchanged for now).

- [ ] **Step 5: Commit**

```bash
git add affirm/lib/cli.ts affirm/tests/cli.test.ts
git commit -m "affirm: bare invocation now shows details; drop --show"
```

---

## Task 5: Mutual exclusion of `-a` and `-r`

**Files:**
- Modify: `affirm/lib/cli.ts`
- Modify: `affirm/tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `affirm/tests/cli.test.ts`:

```ts
test("-a and -r together exit 2 with usage", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const io = collect();
  const code = runCli(["-a", "-r"], opts(dir, hashPath, io));
  expect(code).toBe(2);
  expect(io.err.join("\n")).toContain("mutually exclusive");
  expect(io.err.join("\n")).toContain("Usage:");
});

test("--apply and --revoke together exit 2 with usage", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const io = collect();
  const code = runCli(["--apply", "--revoke"], opts(dir, hashPath, io));
  expect(code).toBe(2);
  expect(io.err.join("\n")).toContain("mutually exclusive");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test affirm/tests/cli.test.ts -t "mutually exclusive"`
Expected: FAIL — second arg is currently ignored, so `["-a", "-r"]` runs as `-a` and exits 0.

- [ ] **Step 3: Implement**

In `affirm/lib/cli.ts`, right after parsing `--help`, add the mutual-exclusion check. Before the help check or after — concretely, replace the start of `runCli` with:

```ts
export function runCli(argv: string[], opts: CliOpts): number {
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    opts.out(usage());
    return 0;
  }
  const wantsApply = args.has("-a") || args.has("--apply");
  const wantsRevoke = args.has("-r") || args.has("--revoke");
  if (wantsApply && wantsRevoke) {
    opts.err(`-a/--apply and -r/--revoke are mutually exclusive\n\n${usage()}`);
    return 2;
  }
  const arg = argv[0];
```

(The rest of the function stays as-is. We still inspect `arg = argv[0]` for the single-flag dispatch; the Set is only used for the conflict check.)

- [ ] **Step 4: Run and verify pass**

Run: `bun test affirm/tests/cli.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add affirm/lib/cli.ts affirm/tests/cli.test.ts
git commit -m "affirm: reject -a and -r together"
```

---

## Task 6: Prefix `Affirm:` in the SessionStart banner

**Files:**
- Modify: `affirm/hooks/session-start.ts`
- Modify: `affirm/tests/session-start.test.ts`

- [ ] **Step 1: Update existing tests to expect the prefix**

In `affirm/tests/session-start.test.ts`, change each occurrence of `"Instruction files in this project:"` to `"Affirm: instruction files in this project:"`. There are 1–2 occurrences (currently in `"banner marks all files NEW..."`). Also add a dedicated assertion:

```ts
test("banner is prefixed with 'Affirm:'", () => {
  const home = mkDir("affirm-home-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const dir = mkDir("affirm-proj-");
  writeFileSync(join(dir, "CLAUDE.md"), "v1");

  const res = spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: home },
  });
  const json = JSON.parse(res.stdout);
  expect(json.systemMessage.startsWith("Affirm:")).toBe(true);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `bun test affirm/tests/session-start.test.ts`
Expected: FAIL — banner currently starts with `"Instruction files..."`.

- [ ] **Step 3: Implement**

In `affirm/hooks/session-start.ts`, change the first line of `buildBanner`:

```ts
  let msg = "Affirm: instruction files in this project:\n";
```

- [ ] **Step 4: Run and verify pass**

Run: `bun test affirm/tests/session-start.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add affirm/hooks/session-start.ts affirm/tests/session-start.test.ts
git commit -m "affirm: prefix SessionStart banner with 'Affirm:'"
```

---

## Task 7: Collapse SKILL.md to a thin pass-through

The skill no longer prompts the user. It maps `/affirm`, `/affirm -a`, `/affirm -r`, `/affirm --help` directly to CLI invocations and relays output. Per item #9: no LLM-in-the-loop steps.

**Files:**
- Modify: `affirm/skills/affirm/SKILL.md`

- [ ] **Step 1: Rewrite the file**

Replace `affirm/skills/affirm/SKILL.md` with:

````markdown
---
name: affirm
description: Affirm, show, or revoke trust in the current project's CLAUDE.md and .claude/rules/* files. Use after reviewing changes flagged by the SessionStart hook. Invoke as /affirm.
---

# `/affirm` — affirm project instruction files

`CLAUDE.md` and anything under `.claude/rules/` are loaded as Claude's system instructions for this project. A malicious or accidental change can silently re-program Claude. `/affirm` is the explicit trust gate: bare `/affirm` shows you what's there; `/affirm -a` records SHA-256 hashes once you've reviewed; `/affirm -r` revokes. The SessionStart hook compares stored hashes on every session start and warns on any mismatch.

## Procedure

Forward args to the CLI verbatim and relay output to the user. No confirmation prompts — the user types `-a` when they're ready to attest.

The CLI lives at `<skill-base-dir>/../../lib/cli.ts`.

### Bare `/affirm` — show details

```bash
bun run "<skill-base-dir>/../../lib/cli.ts"
```

Relay the output. This is read-only — nothing is recorded.

### `/affirm -a` (or `--apply`) — record hashes

```bash
bun run "<skill-base-dir>/../../lib/cli.ts" -a
```

Relay the output. The user invoking `-a` *is* the attestation; do not add a separate confirmation step.

### `/affirm -r` (or `--revoke`) — drop affirmation

```bash
bun run "<skill-base-dir>/../../lib/cli.ts" -r
```

Relay the output.

### `/affirm --help`

```bash
bun run "<skill-base-dir>/../../lib/cli.ts" --help
```

Relay the output.

## What this skill does NOT do

- Read the contents of `CLAUDE.md` or rules files. That's the user's job — they're the one attesting.
- Modify any instruction file. Affirmation is hash-only.
- Touch files outside `<cwd>/CLAUDE.md` and `<cwd>/.claude/rules/*`. User-global `~/.claude/CLAUDE.md` is out of scope.
- Prompt the user "are you sure?". The flag is the attestation.

## Edge cases

- **No instruction files in cwd:** the CLI prints a single line and exits. Relay that and stop.
- **Unknown flag:** the CLI exits 2 with usage. Relay it.
- **`-a` and `-r` together:** the CLI exits 2 with a "mutually exclusive" error. Relay it.
- **Hash file at `~/.claude/affirm-hashes.json` is missing or unparseable:** the CLI treats it as empty and writes a fresh one on next `-a`. No action needed.
````

- [ ] **Step 2: Sanity-check by invoking the CLI directly**

Run: `bun run affirm/lib/cli.ts --help`
Expected: usage block matches what the skill describes.

Run: `bun run affirm/lib/cli.ts` (from the project root)
Expected: details output for this project's CLAUDE.md.

- [ ] **Step 3: Commit**

```bash
git add affirm/skills/affirm/SKILL.md
git commit -m "affirm: collapse SKILL.md to a thin CLI pass-through"
```

---

## Task 8: Refresh README and project CLAUDE.md

**Files:**
- Modify: `affirm/README.md`
- Modify: `CLAUDE.md` (project root)

- [ ] **Step 1: Update `affirm/README.md`**

Two sections need edits:

(a) Replace the entire `## Commands` section with:

```markdown
## Commands

### `/affirm`

Read-only. Shows each instruction file in the current cwd with its affirmation status, modification time, and git info (last commit author + date, and whether there are uncommitted local changes).

### `/affirm -a` (or `--apply`)

Records SHA-256 hashes for every `CLAUDE.md` / `.claude/rules/*` file in the current cwd to `~/.claude/affirm-hashes.json`. Invoking `-a` is itself the attestation — there's no separate "are you sure?" prompt.

### `/affirm -r` (or `--revoke`)

Removes affirmation records for the current cwd. The next session will surface those files as `NEW`. Useful for forcing yourself to re-review.
```

(b) Replace the `## Direct CLI use` code block with:

```markdown
## Direct CLI use

If you don't want to go through the skill, run the CLI from a shell in the project root:

```bash
bun run <plugin-root>/lib/cli.ts          # show details
bun run <plugin-root>/lib/cli.ts -a       # record hashes
bun run <plugin-root>/lib/cli.ts -r       # revoke
```
```

(c) Update the `## Banner format` example's first line from `Instruction files in this project:` to `Affirm: instruction files in this project:`.

- [ ] **Step 2: Update project `CLAUDE.md`**

In `/Volumes/chonk/projects/enfurbish/CLAUDE.md`, in the `## Runtime & commands` section, replace the existing affirm CLI examples:

Current:
```bash
# Run the affirm CLI against a real project (cwd-scoped)
bun run affirm/lib/cli.ts --show
bun run affirm/lib/cli.ts            # affirm all
bun run affirm/lib/cli.ts --revoke
```

New:
```bash
# Run the affirm CLI against a real project (cwd-scoped)
bun run affirm/lib/cli.ts            # show details (status, mtime, git info)
bun run affirm/lib/cli.ts -a         # record hashes
bun run affirm/lib/cli.ts -r         # revoke
```

Also in `## Architecture of affirm`, update the sentence describing what the skill does. Current:

> The skill shows the user file status first, gets confirmation, then runs the appropriate CLI subcommand.

New:

> The skill is a thin pass-through: it forwards args to the CLI verbatim and relays output. No confirmation prompt — invoking with `-a` is itself the attestation.

- [ ] **Step 3: Commit**

```bash
git add affirm/README.md CLAUDE.md
git commit -m "affirm: docs — reflect new CLI surface and skill pass-through"
```

---

## Task 9: Final full-suite verification

- [ ] **Step 1: Run the entire test suite**

Run: `bun test`
Expected: all tests pass across `affirm/` and `continuity/`.

- [ ] **Step 2: Manual smoke test against this repo**

Run: `bun run affirm/lib/cli.ts`
Expected: details output for `/Volumes/chonk/projects/enfurbish/CLAUDE.md` showing `status: affirmed` (we affirmed it earlier this session), an ISO mtime, and a `git:` line with the last commit author.

Run: `CLAUDE_PROJECT_DIR=$(pwd) bun run affirm/hooks/session-start.ts | jq -r .systemMessage`
Expected: banner starting with `Affirm: instruction files in this project:`.

- [ ] **Step 3: Confirm no stray TODO or unused imports**

Run: `grep -rn "TODO\|XXX\|FIXME" affirm/ | grep -v node_modules || true`
Expected: empty (no TODO markers introduced by this work).

- [ ] **Step 4: Final commit if anything pending**

No source changes expected at this point — if `git status` is clean, skip.

---

## Self-review checklist

**1. Spec coverage:**

| TODO item | Task that addresses it |
|---|---|
| #2 (affirm names self in SessionStart) | Task 6 |
| #3 (drop are-you-sure gate) | Task 7 (skill rewrite) |
| #4 (show mtime) | Tasks 1, 4 |
| #5 (git status/author) | Tasks 2, 4 |
| #9 (deterministic, no LLM context burn) | Task 7 (skill = pass-through) |
| #1 (date deltas) | **Deferred** — noted at top, ISO timestamps used |
| #6, #7, #8 | **Deferred** — continuity-side |

**2. Placeholder scan:** No TBDs, no "implement later", no "similar to Task N" without code. Every code block is complete and pastable.

**3. Type consistency:** `GitInfo` defined in Task 2; consumed in Task 4. `getMtime` returns `number | null`; consumer in Task 4 checks for `null`. CLI flag names match across `usage()`, dispatch, SKILL.md, and README.
