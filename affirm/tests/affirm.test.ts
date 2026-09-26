import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveAll,
  classify,
  collectInstructionFiles,
  loadHashes,
  normalizeProjectDir,
  saveHashes,
  sha256OfFile,
} from "../lib/affirm";

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

// symbion e36. Claude Code loads symlinks under .claude/rules/ — files and directories
// both, per its memory docs ("The .claude/rules/ directory supports symlinks"), with
// `ln -s ~/shared-claude-rules .claude/rules/shared` as the example. Skipping them
// left exactly that shape unwatched while it loaded. Hashed at the real path, which
// is where the content lives and what the banner then shows.
test("collectInstructionFiles follows a symlinked directory under .claude/rules/", () => {
  const { dir } = mkProject();
  const other = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-other-")));
  writeFileSync(join(other, "evil.md"), "via-symlink");
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  symlinkSync(other, join(dir, ".claude", "rules", "linked"));
  writeFileSync(join(dir, ".claude", "rules", "real.md"), "real");
  const files = collectInstructionFiles(dir);
  expect(files).toEqual([join(dir, ".claude", "rules", "real.md"), join(other, "evil.md")].sort());
});

test("collectInstructionFiles follows a symlinked file under .claude/rules/", () => {
  const { dir } = mkProject();
  const other = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-other-")));
  writeFileSync(join(other, "sneaky.md"), "via-symlink");
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  symlinkSync(join(other, "sneaky.md"), join(dir, ".claude", "rules", "sneaky.md"));
  expect(collectInstructionFiles(dir)).toEqual([join(other, "sneaky.md")]);
});

// Two links back up, not one. With one, a walk that has no cycle guard still ends:
// the OS refuses a path past 32 symlink hops (ELOOP) and the graph dedupes by real
// path, so the output is identical. With two it branches at every level — 2^32
// walks — so a missing guard hangs this test instead of passing it.
test("a symlink cycle under .claude/rules/ terminates", () => {
  const { dir } = mkProject();
  const rules = join(dir, ".claude", "rules");
  mkdirSync(join(rules, "sub"), { recursive: true });
  writeFileSync(join(rules, "sub", "a.md"), "a");
  symlinkSync(rules, join(rules, "sub", "up")); // sub/up -> rules, which holds sub
  symlinkSync(rules, join(rules, "sub", "up2"));
  expect(collectInstructionFiles(dir)).toEqual([join(rules, "sub", "a.md")]);
});

test("a dangling symlink under .claude/rules/ is skipped, no throw", () => {
  const { dir } = mkProject();
  const rules = join(dir, ".claude", "rules");
  mkdirSync(rules, { recursive: true });
  symlinkSync(join(dir, "nowhere.md"), join(rules, "gone.md"));
  writeFileSync(join(rules, "real.md"), "real");
  expect(collectInstructionFiles(dir)).toEqual([join(rules, "real.md")]);
});

test("collectInstructionFiles follows @imports in CLAUDE.md", () => {
  const { dir } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "base instructions, see @extra.md");
  writeFileSync(join(dir, "extra.md"), "imported instructions");
  const files = collectInstructionFiles(dir);
  expect(files).toContain(join(dir, "CLAUDE.md"));
  expect(files).toContain(join(dir, "extra.md"));
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

test("approveAll says what each file was before it was affirmed", () => {
  const { dir, hashPath } = mkProject();
  const at = (f: string) => join(dir, f);
  writeFileSync(at("CLAUDE.md"), "v1");
  writeFileSync(at("CLAUDE.local.md"), "mine");
  saveHashes({ [at("CLAUDE.md")]: sha256OfFile(at("CLAUDE.md")), [at("CLAUDE.local.md")]: "stale" }, hashPath);
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  writeFileSync(at(".claude/rules/new.md"), "new");
  const prior = Object.fromEntries(approveAll(dir, hashPath).approved.map((a) => [a.path, a.prior]));
  expect(prior).toEqual({
    [at("CLAUDE.md")]: "unchanged",
    [at("CLAUDE.local.md")]: "changed",
    [at(".claude/rules/new.md")]: "new",
  });
});

test("approveAll preserves entries for other projects", () => {
  const { dir, hashPath } = mkProject();
  saveHashes({ "/other/proj/CLAUDE.md": "deadbeef" }, hashPath);
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  approveAll(dir, hashPath);
  expect(loadHashes(hashPath)["/other/proj/CLAUDE.md"]).toBe("deadbeef");
});

// --- unreadable files: reported, never dropped, never fatal ----------------------

/** A project with a readable CLAUDE.md and a rule nobody can read (chmod 000). */
function projectWithLockedRule() {
  const p = mkProject();
  writeFileSync(join(p.dir, "CLAUDE.md"), "rules");
  mkdirSync(join(p.dir, ".claude", "rules"), { recursive: true });
  const locked = join(p.dir, ".claude", "rules", "locked.md");
  writeFileSync(locked, "secret");
  chmodSync(locked, 0o000);
  return { ...p, locked };
}

// symbion b6e: `-a` threw EACCES on the locked rule and never wrote the store, so the
// readable CLAUDE.md went unaffirmed too.
test("approveAll affirms what it can read and reports what it cannot", () => {
  const { dir, hashPath, locked } = projectWithLockedRule();
  const { approved, unreadable } = approveAll(dir, hashPath);
  expect(approved.map((a) => a.path)).toEqual([join(dir, "CLAUDE.md")]);
  expect(unreadable).toEqual([locked]);
  const stored = loadHashes(hashPath);
  expect(stored[join(dir, "CLAUDE.md")]).toBeString();
  expect(stored[locked]).toBeUndefined();
});

// symbion e63: classify skipped the file and nothing downstream ever mentioned it.
test("classify reports an unreadable file instead of dropping it", () => {
  const { dir, locked } = projectWithLockedRule();
  const c = classify(collectInstructionFiles(dir), {});
  expect(c.added).toEqual([join(dir, "CLAUDE.md")]);
  expect(c.unreadable).toEqual([locked]);
});
