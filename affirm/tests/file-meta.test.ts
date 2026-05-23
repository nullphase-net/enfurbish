import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMtime, getGitInfo } from "../lib/file-meta";

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
