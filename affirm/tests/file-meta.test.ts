import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitsTouching, getMtime, getGitInfo } from "../lib/file-meta";

function gitInit(dir: string) {
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
}

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

// Two real-git failure stimuli, measured on git 2.x (2026-09-26): garbage in
// .git/index makes status, ls-files and check-ignore exit 128 while log still works;
// a branch ref naming a missing object makes log and status exit 128 while ls-files
// and check-ignore still work. A failed call must read as unknown, not as "no".
function committed(prefix: string): { dir: string; f: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  gitInit(dir);
  const f = join(dir, "x.md");
  writeFileSync(f, "v1");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return { dir, f };
}

test("getGitInfo marks a failed git status unknown, not clean", () => {
  const { dir, f } = committed("file-meta-badindex-");
  writeFileSync(join(dir, ".git", "index"), "garbage");
  const info = getGitInfo(dir, f);
  expect(info.lastCommit?.author).toBe("Test User");
  expect(info.unknown).toBe(true);
});

test("getGitInfo marks a failed git log unknown, not untracked", () => {
  const { dir, f } = committed("file-meta-badref-");
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "1234567890123456789012345678901234567890\n");
  const info = getGitInfo(dir, f);
  expect(info.lastCommit).toBeNull();
  expect(info.unknown).toBe(true);
});

test("getGitInfo leaves unknown unset when every call answered", () => {
  const { dir, f } = committed("file-meta-ok-");
  expect(getGitInfo(dir, f).unknown).toBeUndefined();
});

test("commitsTouching returns null when git log fails, which is not []", () => {
  const { dir, f } = committed("file-meta-touch-");
  expect(commitsTouching(dir, f, "2020-01-01T00:00:00Z")).toEqual(["init"]);
  writeFileSync(join(dir, ".git", "refs", "heads", "main"), "1234567890123456789012345678901234567890\n");
  expect(commitsTouching(dir, f, "2020-01-01T00:00:00Z")).toBeNull();
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
  expect(info.dirty).toBe(true);
});
