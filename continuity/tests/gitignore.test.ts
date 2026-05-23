import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIgnoredDirs, isFileIgnored, isFileTracked } from "../lib/gitignore";
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
