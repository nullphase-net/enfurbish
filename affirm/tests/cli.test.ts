import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../lib/cli";
import { loadHashes, normalizeProjectDir, saveHashes, sha256OfFile } from "../lib/affirm";

type CollectedIO = { out: string[]; err: string[] };
function collect(): CollectedIO {
  return { out: [], err: [] };
}
function opts(cwd: string, hashPath: string, io: CollectedIO) {
  return {
    cwd,
    hashPath,
    out: (s: string) => io.out.push(s),
    err: (s: string) => io.err.push(s),
  };
}

// In-process tests must not read the developer's real ~/.claude — os.homedir() is cached
// at startup in Bun, so HOME cannot be moved from here. AFFIRM_GLOBAL_DIR is read per call.
const EMPTY_GLOBAL = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-noglobal-")));
process.env.AFFIRM_GLOBAL_DIR = EMPTY_GLOBAL;

/** Point the global root at `dir` for one test, then put it back. */
function withGlobalDir<T>(dir: string, fn: () => T): T {
  process.env.AFFIRM_GLOBAL_DIR = dir;
  try {
    return fn();
  } finally {
    process.env.AFFIRM_GLOBAL_DIR = EMPTY_GLOBAL;
  }
}

function mkProject() {
  const dir = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-cli-proj-")));
  const hashPath = join(normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-cli-store-"))), "hashes.json");
  return { dir, hashPath };
}

test("--help prints usage and exits 0", () => {
  const { dir, hashPath } = mkProject();
  const io = collect();
  const code = runCli(["--help"], opts(dir, hashPath, io));
  expect(code).toBe(0);
  expect(io.out.join("\n")).toContain("Usage:");
});

test("no instruction files: prints message and exits 0", () => {
  const { dir, hashPath } = mkProject();
  const io = collect();
  const code = runCli([], opts(dir, hashPath, io));
  expect(code).toBe(0);
  expect(io.out.join("\n")).toContain("No CLAUDE.md or .claude/rules/ files found");
});

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

test("bare invocation shows @import provenance and depth", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "base instructions, see @extra.md");
  writeFileSync(join(dir, "extra.md"), "imported");
  const io = collect();
  runCli([], opts(dir, hashPath, io));
  const out = io.out.join("\n");
  expect(out).toContain("extra.md");
  expect(out).toMatch(/import:\s+.*CLAUDE\.md/);
  expect(out).toMatch(/depth 1/);
});

test("bare invocation flags out-of-tree imports", () => {
  const { dir, hashPath } = mkProject();
  const ext = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-cli-ext-")));
  writeFileSync(join(ext, "shared.md"), "shared");
  writeFileSync(join(dir, "CLAUDE.md"), `@${join(ext, "shared.md")}`);
  const io = collect();
  runCli([], opts(dir, hashPath, io));
  expect(io.out.join("\n")).toMatch(/scope:\s+out-of-tree/);
});

test("bare invocation summarizes @imports beyond depth 2", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "@a.md");
  writeFileSync(join(dir, "a.md"), "@b.md");
  writeFileSync(join(dir, "b.md"), "@c.md");
  writeFileSync(join(dir, "c.md"), "deep");
  const io = collect();
  runCli([], opts(dir, hashPath, io));
  const out = io.out.join("\n");
  expect(out).toContain("beyond depth 2");
  expect(out).toMatch(/b\.md → c\.md/);
});

test("--show is no longer recognized", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const io = collect();
  const code = runCli(["--show"], opts(dir, hashPath, io));
  expect(code).toBe(2);
  expect(io.err.join("\n")).toContain("Unknown argument: --show");
});

test("unknown argument exits 2 with usage on stderr", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const io = collect();
  const code = runCli(["--bogus"], opts(dir, hashPath, io));
  expect(code).toBe(2);
  expect(io.err.join("\n")).toContain("Unknown argument: --bogus");
  expect(io.err.join("\n")).toContain("Usage:");
});

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


// --- --since: the mtime gate that separates "you did this" from a trust event ---

function projectWithClaudeMd(body: string) {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), body);
  return { dir, hashPath };
}

test("--since reports a file touched inside the window and asks for review", () => {
  const { dir, hashPath } = projectWithClaudeMd("# rules\n");
  const io = collect();
  // Window opens before the file was written, so its mtime falls inside it.
  expect(runCli(["--since", "2020-01-01T00:00:00Z"], opts(dir, hashPath, io))).toBe(0);
  const out = io.out.join("\n");
  expect(out).toContain("1 of 1 touched");
  expect(out).toContain("NEW");
  expect(out).toContain("run /affirm -a after reviewing");
});

// The other direction, and the one the seven journal loggings were about: outside
// the window there must be no prompt at all.
test("--since says nothing to do when the window opened after the last edit", () => {
  const { dir, hashPath } = projectWithClaudeMd("# rules\n");
  const io = collect();
  expect(runCli(["--since", "2999-01-01T00:00:00Z"], opts(dir, hashPath, io))).toBe(0);
  const out = io.out.join("\n");
  expect(out).toContain("0 of 1 instruction file touched");
  expect(out).not.toContain("run /affirm");
});

// Touched but unchanged: prompting here is exactly the alert fatigue the gate exists
// to prevent, so the file is listed and the call to action is not.
test("--since lists an affirmed file without prompting to re-affirm it", () => {
  const { dir, hashPath } = projectWithClaudeMd("# rules\n");
  const approve = collect();
  runCli(["-a"], opts(dir, hashPath, approve));

  const io = collect();
  runCli(["--since", "2020-01-01T00:00:00Z"], opts(dir, hashPath, io));
  const out = io.out.join("\n");
  expect(out).toContain("1 of 1 touched");
  expect(out).toContain("affirmed");
  expect(out).not.toContain("run /affirm -a after reviewing");
});

test("--since rejects a missing or unparseable timestamp", () => {
  const { dir, hashPath } = projectWithClaudeMd("# rules\n");
  const io = collect();
  expect(runCli(["--since"], opts(dir, hashPath, io))).toBe(2);

  const io2 = collect();
  expect(runCli(["--since", "yesterday-ish"], opts(dir, hashPath, io2))).toBe(0);
  expect(io2.out.join("\n")).toContain("unparseable timestamp");
});

test("-a renders a global file as ~/… , not a ../../.. climb", () => {
  const g = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-cli-gdir-")));
  writeFileSync(join(g, "CLAUDE.md"), "global root");
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "project root");
  const io = collect();

  withGlobalDir(g, () => runCli(["-a"], opts(dir, hashPath, io)));
  const out = io.out.join("\n");
  expect(out).toContain("Affirmed 2 files");
  expect(out).not.toContain("..");
  expect(out).toContain(join(g, "CLAUDE.md"));
  expect(loadHashes(hashPath)[join(g, "CLAUDE.md")]).toBeString();
});

test("bare affirm labels a global file scope: global", () => {
  const g = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-cli-gscope-")));
  writeFileSync(join(g, "CLAUDE.md"), "global root");
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "project root");
  const io = collect();

  withGlobalDir(g, () => runCli([], opts(dir, hashPath, io)));
  const out = io.out.join("\n");
  expect(out).toContain("scope:    global");
  expect(out).not.toContain("scope:    out-of-tree");
});

// --- unreadable files ------------------------------------------------------------

function projectWithLockedRule() {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  const locked = join(dir, ".claude", "rules", "locked.md");
  writeFileSync(locked, "secret");
  chmodSync(locked, 0o000);
  return { dir, hashPath, locked };
}

test("-a affirms the readable files and names the one it could not read", () => {
  const { dir, hashPath } = projectWithLockedRule();
  const io = collect();
  expect(runCli(["-a"], opts(dir, hashPath, io))).toBe(0);
  const out = io.out.join("\n");
  expect(out).toContain("Affirmed 1 file");
  expect(out).toContain(".claude/rules/locked.md  (unreadable — not affirmed)");
});

// symbion e63, second half: the NEW check returned first, so `unreadable` was
// unreachable for any file not already in the store.
test("bare invocation says unreadable for a file that was never affirmed", () => {
  const { dir, hashPath } = projectWithLockedRule();
  const io = collect();
  runCli([], opts(dir, hashPath, io));
  const out = io.out.join("\n");
  expect(out).toMatch(/locked\.md\n\s+status:\s+unreadable/);
  expect(out).toMatch(/CLAUDE\.md\n\s+status:\s+NEW/);
});

// --- --since: say why there are no commits, when git cannot see the file ----------

function gitInit(dir: string) {
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test User"],
    ["config", "commit.gpgsign", "false"],
  ]) spawnSync("git", args, { cwd: dir });
}

function sinceLine(dir: string, hashPath: string): string {
  const io = collect();
  runCli(["--since", "2020-01-01T00:00:00Z"], opts(dir, hashPath, io));
  return io.out.find((l) => l.includes("CLAUDE.md")) ?? "";
}

// symbion 233: this repo's own CLAUDE.md is gitignored, and "no commits in window"
// read as reassurance about a file git can never report on.
test("--since says a gitignored file is invisible to git, not that it has no commits", () => {
  const { dir, hashPath } = projectWithClaudeMd("# rules\n");
  gitInit(dir);
  writeFileSync(join(dir, ".gitignore"), "CLAUDE.md\n");
  const line = sinceLine(dir, hashPath);
  expect(line).toContain("untracked (gitignored)");
  expect(line).not.toContain("no commits in window");
});

test("--since says an untracked file is invisible to git", () => {
  const { dir, hashPath } = projectWithClaudeMd("# rules\n");
  gitInit(dir);
  const line = sinceLine(dir, hashPath);
  expect(line).toContain("untracked");
  expect(line).not.toContain("gitignored");
  expect(line).not.toContain("no commits in window");
});

test("--since says a file outside any repo is outside any repo", () => {
  const { dir, hashPath } = projectWithClaudeMd("# rules\n");
  const line = sinceLine(dir, hashPath);
  expect(line).toContain("not in a git repo");
  expect(line).not.toContain("no commits in window");
});

// The other direction: for a tracked file the old words were true, and stay.
test("--since keeps 'no commits in window' for a tracked file committed before it", () => {
  const { dir, hashPath } = projectWithClaudeMd("# rules\n");
  gitInit(dir);
  spawnSync("git", ["add", "CLAUDE.md"], { cwd: dir });
  const old = "2019-06-01T00:00:00Z";
  spawnSync("git", ["commit", "-q", "-m", "old"], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
  });
  utimesSync(join(dir, "CLAUDE.md"), new Date(), new Date()); // touched inside the window
  expect(sinceLine(dir, hashPath)).toContain("no commits in window");
});
