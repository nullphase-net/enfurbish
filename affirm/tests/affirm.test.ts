import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveAll,
  classify,
  collectInstructionFiles,
  loadHashes,
  normalizeProjectDir,
  revokeProject,
  saveHashes,
  sha256OfFile,
} from "../lib/affirm";

function mkProject(): { dir: string; hashPath: string } {
  const dir = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-proj-")));
  const hashPath = join(normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-store-"))), "hashes.json");
  return { dir, hashPath };
}

test("collectInstructionFiles returns [] when nothing present", () => {
  const { dir } = mkProject();
  expect(collectInstructionFiles(dir)).toEqual([]);
});

test("collectInstructionFiles picks up CLAUDE.md at root", () => {
  const { dir } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  expect(collectInstructionFiles(dir)).toEqual([join(dir, "CLAUDE.md")]);
});

test("collectInstructionFiles recursively walks .claude/rules/", () => {
  const { dir } = mkProject();
  mkdirSync(join(dir, ".claude", "rules", "sub"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "root");
  writeFileSync(join(dir, ".claude", "rules", "a.md"), "a");
  writeFileSync(join(dir, ".claude", "rules", "sub", "b.md"), "b");
  const files = collectInstructionFiles(dir);
  expect(files).toEqual([
    join(dir, ".claude", "rules", "a.md"),
    join(dir, ".claude", "rules", "sub", "b.md"),
    join(dir, "CLAUDE.md"),
  ]);
});

test("collectInstructionFiles skips symlinks under .claude/rules/", () => {
  const { dir } = mkProject();
  const other = mkdtempSync(join(tmpdir(), "affirm-other-"));
  writeFileSync(join(other, "evil.md"), "via-symlink");
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  symlinkSync(other, join(dir, ".claude", "rules", "linked"));
  writeFileSync(join(dir, ".claude", "rules", "real.md"), "real");
  const files = collectInstructionFiles(dir);
  expect(files).toEqual([join(dir, ".claude", "rules", "real.md")]);
});

test("loadHashes returns {} when file missing or unparseable", () => {
  const { hashPath } = mkProject();
  expect(loadHashes(hashPath)).toEqual({});
  writeFileSync(hashPath, "not-json");
  expect(loadHashes(hashPath)).toEqual({});
});

test("saveHashes + loadHashes round-trip", () => {
  const { hashPath } = mkProject();
  saveHashes({ "/x/y": "abc" }, hashPath);
  expect(loadHashes(hashPath)).toEqual({ "/x/y": "abc" });
});

test("saveHashes writes atomically via temp + rename", () => {
  const { hashPath } = mkProject();
  saveHashes({ a: "1" }, hashPath);
  // Confirm trailing newline + JSON formatting (humans may eyeball this file)
  const raw = readFileSync(hashPath, "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  expect(JSON.parse(raw)).toEqual({ a: "1" });
});

test("classify buckets files into approved / added / changed", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "v1");
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  writeFileSync(join(dir, ".claude", "rules", "stable.md"), "stable");
  writeFileSync(join(dir, ".claude", "rules", "new.md"), "fresh");

  const files = collectInstructionFiles(dir);
  // Pre-approve only CLAUDE.md and stable.md
  const stored: Record<string, string> = {
    [join(dir, "CLAUDE.md")]: sha256OfFile(join(dir, "CLAUDE.md")),
    [join(dir, ".claude", "rules", "stable.md")]: sha256OfFile(join(dir, ".claude", "rules", "stable.md")),
  };
  // Modify CLAUDE.md after pre-approval
  writeFileSync(join(dir, "CLAUDE.md"), "v2-mutated");
  saveHashes(stored, hashPath);

  const c = classify(files, loadHashes(hashPath));
  expect(c.approved).toEqual([join(dir, ".claude", "rules", "stable.md")]);
  expect(c.changed).toEqual([join(dir, "CLAUDE.md")]);
  expect(c.added).toEqual([join(dir, ".claude", "rules", "new.md")]);
});

test("approveAll records hashes for every instruction file", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const { approved } = approveAll(dir, hashPath);
  expect(approved).toHaveLength(1);
  expect(approved[0]!.path).toBe(join(dir, "CLAUDE.md"));
  const stored = loadHashes(hashPath);
  expect(stored[join(dir, "CLAUDE.md")]).toBe(approved[0]!.hash);
});

test("approveAll preserves entries for other projects", () => {
  const { dir, hashPath } = mkProject();
  saveHashes({ "/other/proj/CLAUDE.md": "deadbeef" }, hashPath);
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  approveAll(dir, hashPath);
  expect(loadHashes(hashPath)["/other/proj/CLAUDE.md"]).toBe("deadbeef");
});

test("revokeProject removes only this project's entries", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  approveAll(dir, hashPath);
  saveHashes({ ...loadHashes(hashPath), "/other/proj/CLAUDE.md": "deadbeef" }, hashPath);

  const { revoked } = revokeProject(dir, hashPath);
  expect(revoked).toEqual([join(dir, "CLAUDE.md")]);
  expect(loadHashes(hashPath)).toEqual({ "/other/proj/CLAUDE.md": "deadbeef" });
});

test("revokeProject is a no-op when nothing was affirmed", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const { revoked } = revokeProject(dir, hashPath);
  expect(revoked).toEqual([]);
});
