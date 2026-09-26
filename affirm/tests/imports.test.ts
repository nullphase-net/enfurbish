import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  parseImports,
  resolveImport,
  displayPath,
  buildInstructionGraph,
  MAX_IMPORT_DEPTH,
} from "../lib/imports";

function normalizeProjectDir(d: string): string {
  return realpathSync(d);
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

// ---------- parseImports ----------

test("parseImports extracts a single @import", () => {
  expect(parseImports("See @docs/a.md for details")).toEqual(["docs/a.md"]);
});

test("parseImports extracts multiple @imports", () => {
  expect(parseImports("@a.md and also @sub/b.md")).toEqual(["a.md", "sub/b.md"]);
});

test("parseImports ignores email addresses", () => {
  expect(parseImports("mail me@example.com please")).toEqual([]);
});

test("parseImports skips inline code spans", () => {
  expect(parseImports("literal `@a.md` mention")).toEqual([]);
});

test("parseImports skips fenced code blocks", () => {
  expect(parseImports("text\n```\n@a.md\n```\nmore")).toEqual([]);
});

test("parseImports handles ~ and absolute paths", () => {
  expect(parseImports("@~/x.md and @/abs/y.md")).toEqual(["~/x.md", "/abs/y.md"]);
});

test("parseImports handles parent-relative paths", () => {
  expect(parseImports("@../sibling.md")).toEqual(["../sibling.md"]);
});

// ---------- resolveImport ----------

test("resolveImport resolves relative against the importing file's dir", () => {
  expect(resolveImport("docs/a.md", "/proj")).toBe("/proj/docs/a.md");
});

test("resolveImport resolves parent segments", () => {
  expect(resolveImport("../a.md", "/proj/sub")).toBe("/proj/a.md");
});

test("resolveImport keeps absolute paths", () => {
  expect(resolveImport("/abs/x.md", "/proj")).toBe("/abs/x.md");
});

test("resolveImport expands ~ to home", () => {
  expect(resolveImport("~/x.md", "/proj")).toBe(join(homedir(), "x.md"));
});

// ---------- displayPath ----------

test("displayPath shows in-tree files relative to the project", () => {
  expect(displayPath("/proj", "/proj/docs/a.md")).toBe("docs/a.md");
});

test("displayPath abbreviates home for out-of-tree files", () => {
  expect(displayPath("/proj", join(homedir(), ".claude", "x.md"))).toBe("~/.claude/x.md");
});

// ---------- buildInstructionGraph ----------

function mkProj(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "affirm-graph-")));
}

test("graph: root CLAUDE.md only", () => {
  const dir = mkProj();
  writeFileSync(join(dir, "CLAUDE.md"), "no imports here");
  const g = buildInstructionGraph(dir);
  expect(g.files).toEqual([
    { path: join(dir, "CLAUDE.md"), depth: 0, via: null, outOfTree: false, global: false, ancestor: false },
  ]);
  expect(g.deep).toEqual([]);
});

test("graph: follows a one-level import", () => {
  const dir = mkProj();
  writeFileSync(join(dir, "CLAUDE.md"), "see @extra.md");
  writeFileSync(join(dir, "extra.md"), "imported content");
  const g = buildInstructionGraph(dir);
  const extra = g.files.find((f) => f.path === join(dir, "extra.md"));
  expect(extra).toBeDefined();
  expect(extra!.depth).toBe(1);
  expect(extra!.via).toBe(join(dir, "CLAUDE.md"));
  expect(extra!.outOfTree).toBe(false);
});

// Claude Code follows four hops: measured 2026-09-26 on 2.1.283, a chain i1..i5 from a
// CLAUDE.local.md loaded i1-i4 and not i5. affirm followed two, so i3 and i4 loaded unhashed.
test("graph: follows imports to depth 4, summarizes deeper", () => {
  const dir = mkProj();
  writeFileSync(join(dir, "CLAUDE.md"), "@a.md");
  writeFileSync(join(dir, "a.md"), "@b.md"); // depth 1
  writeFileSync(join(dir, "b.md"), "@c.md"); // depth 2
  writeFileSync(join(dir, "c.md"), "@d.md"); // depth 3
  writeFileSync(join(dir, "d.md"), "@e.md"); // depth 4
  writeFileSync(join(dir, "e.md"), "deep"); // depth 5 — not followed
  const g = buildInstructionGraph(dir);
  const paths = g.files.map((f) => f.path);
  expect(paths).toContain(join(dir, "c.md"));
  expect(paths).toContain(join(dir, "d.md"));
  expect(paths).not.toContain(join(dir, "e.md"));
  expect(g.deep).toEqual([{ via: join(dir, "d.md"), raw: "e.md" }]);
});

test("graph: cycle does not loop forever", () => {
  const dir = mkProj();
  writeFileSync(join(dir, "CLAUDE.md"), "@a.md");
  writeFileSync(join(dir, "a.md"), "@CLAUDE.md"); // back-reference
  const g = buildInstructionGraph(dir);
  const claudeCount = g.files.filter((f) => f.path === join(dir, "CLAUDE.md")).length;
  expect(claudeCount).toBe(1);
});

test("graph: out-of-tree import is hashed but flagged", () => {
  const dir = mkProj();
  const ext = mkProj();
  writeFileSync(join(ext, "shared.md"), "shared");
  writeFileSync(join(dir, "CLAUDE.md"), `@${join(ext, "shared.md")}`);
  const g = buildInstructionGraph(dir);
  const shared = g.files.find((f) => f.path === join(ext, "shared.md"));
  expect(shared).toBeDefined();
  expect(shared!.outOfTree).toBe(true);
});

test("graph: nonexistent imports are skipped, no throw", () => {
  const dir = mkProj();
  writeFileSync(join(dir, "CLAUDE.md"), "@does-not-exist.md");
  const g = buildInstructionGraph(dir);
  expect(g.files.map((f) => f.path)).toEqual([join(dir, "CLAUDE.md")]);
});

test("graph: relative imports resolve against the importing file", () => {
  const dir = mkProj();
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  writeFileSync(join(dir, ".claude", "rules", "a.md"), "@sibling.md");
  writeFileSync(join(dir, ".claude", "rules", "sibling.md"), "sib");
  const g = buildInstructionGraph(dir);
  const paths = g.files.map((f) => f.path);
  expect(paths).toContain(join(dir, ".claude", "rules", "sibling.md"));
});

test("MAX_IMPORT_DEPTH is 4", () => {
  expect(MAX_IMPORT_DEPTH).toBe(4);
});

// ---------- every root Claude Code loads at launch ----------
// Measured 2026-09-26 on Claude Code 2.1.283 (InstructionsLoaded hook log and the model's
// own recall agreed): from a launch dir two levels under a non-repo parent, every directory
// up the tree loaded CLAUDE.md, .claude/CLAUDE.md, .claude/rules/** and CLAUDE.local.md.

function rootPaths(dir: string): string[] {
  return buildInstructionGraph(dir).files.map((f) => f.path);
}

function write(path: string, body = "x") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

for (const name of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) {
  test(`graph: ${name} alone is a root`, () => {
    const dir = mkProj();
    write(join(dir, name));
    const g = buildInstructionGraph(dir);
    expect(g.files.map((f) => [f.path, f.depth, f.ancestor])).toEqual([[join(dir, name), 0, false]]);
  });
}

test("graph: CLAUDE.local.md @imports are followed", () => {
  const dir = mkProj();
  write(join(dir, "CLAUDE.local.md"), "@mine.md");
  write(join(dir, "mine.md"));
  expect(rootPaths(dir)).toContain(join(dir, "mine.md"));
});

test("graph: every ancestor's roots are collected and marked ancestor", () => {
  const top = mkProj();
  const sub = join(top, "repo", "sub");
  mkdirSync(sub, { recursive: true });
  const expected = [
    join(top, "CLAUDE.md"),
    join(top, ".claude", "CLAUDE.md"),
    join(top, "CLAUDE.local.md"),
    join(top, ".claude", "rules", "r.md"),
    join(top, "repo", "CLAUDE.md"),
    join(top, "repo", ".claude", "rules", "deep", "r.md"),
  ];
  for (const p of expected) write(p);
  const files = buildInstructionGraph(sub).files;
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  for (const p of expected) {
    expect(byPath[p]).toBeDefined();
    expect(byPath[p]!.ancestor).toBe(true);
    expect(byPath[p]!.outOfTree).toBe(true);
    expect(byPath[p]!.global).toBe(false);
  }
});

test("graph: an ancestor's imports are followed but are not themselves ancestors", () => {
  const top = mkProj();
  const sub = join(top, "sub");
  mkdirSync(sub);
  write(join(top, "CLAUDE.md"), "@docs/x.md");
  write(join(top, "docs", "x.md"));
  const x = buildInstructionGraph(sub).files.find((f) => f.path === join(top, "docs", "x.md"));
  expect(x?.via).toBe(join(top, "CLAUDE.md"));
  expect(x?.ancestor).toBe(false);
});

// A project under $HOME reaches ~/.claude/CLAUDE.md as an ancestor's .claude/CLAUDE.md.
// It must stay global, or it shows a ✓ line in every banner again.
test("graph: a global root reached as an ancestor file stays global, once", () => {
  const home = mkProj();
  const g = join(home, ".claude");
  write(join(g, "CLAUDE.md"));
  write(join(g, "rules", "r.md"));
  const proj = join(home, "proj");
  mkdirSync(proj);
  const files = withGlobalDir(g, () => buildInstructionGraph(proj).files);
  for (const p of [join(g, "CLAUDE.md"), join(g, "rules", "r.md")]) {
    const hits = files.filter((f) => f.path === p);
    expect(hits.length).toBe(1);
    expect(hits[0]!.global).toBe(true);
    expect(hits[0]!.ancestor).toBe(false);
  }
});

// ---------- AGENTS.md: loads only when no CLAUDE.md-family file does ----------
// Docs (memory, "When Claude Code reads AGENTS.md"), and measured 2026-09-26: AGENTS.md
// loaded from a dir with nothing else, and was skipped beside a CLAUDE.md.

for (const name of ["AGENTS.md", ".claude/AGENTS.md"]) {
  test(`graph: ${name} with no CLAUDE.md-family file is a root`, () => {
    const dir = mkProj();
    write(join(dir, name), "@more.md");
    const more = join(dir, name, "..", "more.md"); // relative to the importing file
    write(more);
    expect(rootPaths(dir)).toEqual([join(dir, name), realpathSync(more)]);
  });
}

// One case per shape that suppresses it, here and in an ancestor.
for (const name of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) {
  test(`graph: AGENTS.md is not a root beside ${name}`, () => {
    const dir = mkProj();
    write(join(dir, "AGENTS.md"));
    write(join(dir, name));
    expect(rootPaths(dir)).toEqual([join(dir, name)]);
  });
  test(`graph: AGENTS.md is not a root under an ancestor's ${name}`, () => {
    const top = mkProj();
    const sub = join(top, "sub");
    write(join(sub, "AGENTS.md"));
    write(join(top, name));
    expect(rootPaths(sub)).not.toContain(join(sub, "AGENTS.md"));
  });
}

// ...and per shape that does not: the global CLAUDE.md and rules files don't count.
test("graph: AGENTS.md is still a root beside a rules file and a global CLAUDE.md", () => {
  const g = mkGlobal("affirm-gdir-agents-");
  write(join(g, "CLAUDE.md"));
  const dir = mkProj();
  write(join(dir, "AGENTS.md"));
  write(join(dir, ".claude", "rules", "r.md"));
  expect(withGlobalDir(g, () => rootPaths(dir))).toContain(join(dir, "AGENTS.md"));
});

function withSetting<T>(instructionFiles: string, fn: (g: string) => T): T {
  const g = mkGlobal("affirm-gdir-setting-");
  const settings = { pluginConfigs: { "agents-md@builtin": { options: { instructionFiles } } } };
  writeFileSync(join(g, "settings.json"), JSON.stringify(settings));
  return withGlobalDir(g, () => fn(g));
}

test("graph: claude-md-and-agents-md makes AGENTS.md a root beside CLAUDE.md", () => {
  const dir = mkProj();
  write(join(dir, "CLAUDE.md"));
  write(join(dir, "AGENTS.md"));
  expect(withSetting("claude-md-and-agents-md", () => rootPaths(dir))).toContain(join(dir, "AGENTS.md"));
});

for (const mode of ["claude-md", "managed-only"]) {
  test(`graph: ${mode} leaves AGENTS.md out even alone`, () => {
    const dir = mkProj();
    write(join(dir, "AGENTS.md"));
    expect(withSetting(mode, () => rootPaths(dir))).toEqual([]);
  });
}

// A value this code does not know is not the negative case: watch the file.
test("graph: an unknown instructionFiles value keeps AGENTS.md watched", () => {
  const dir = mkProj();
  write(join(dir, "CLAUDE.md"));
  write(join(dir, "AGENTS.md"));
  expect(withSetting("some-future-mode", () => rootPaths(dir))).toContain(join(dir, "AGENTS.md"));
});

// ---------- global roots ----------

function mkGlobal(prefix: string): string {
  const g = normalizeProjectDir(mkdtempSync(join(tmpdir(), prefix)));
  return g;
}

test("global CLAUDE.md and rules/ are collected and marked global", () => {
  const g = mkGlobal("affirm-gdir-");
  writeFileSync(join(g, "CLAUDE.md"), "global root");
  mkdirSync(join(g, "rules"), { recursive: true });
  writeFileSync(join(g, "rules", "style.md"), "global rule");
  const proj = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-gproj-")));
  writeFileSync(join(proj, "CLAUDE.md"), "project root");

  const files = withGlobalDir(g, () => buildInstructionGraph(proj).files);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  expect(byPath[join(proj, "CLAUDE.md")]!.global).toBe(false);
  expect(byPath[join(g, "CLAUDE.md")]!.global).toBe(true);
  expect(byPath[join(g, "rules", "style.md")]!.global).toBe(true);
});

test("a global root's @imports inherit global", () => {
  const g = mkGlobal("affirm-gdir-imp-");
  writeFileSync(join(g, "CLAUDE.md"), "see @extra.md");
  writeFileSync(join(g, "extra.md"), "more global rules");
  const proj = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-gproj-imp-")));
  writeFileSync(join(proj, "CLAUDE.md"), "project root");

  const files = withGlobalDir(g, () => buildInstructionGraph(proj).files);
  const extra = files.find((f) => f.path === join(g, "extra.md"));
  expect(extra?.global).toBe(true);
  expect(extra?.via).toBe(join(g, "CLAUDE.md"));
});

test("a file only a project root imports out of the global dir is not global", () => {
  const g = mkGlobal("affirm-gdir-shared-");
  writeFileSync(join(g, "shared.md"), "pulled in deliberately"); // not a global root
  const proj = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-gproj-shared-")));
  writeFileSync(join(proj, "CLAUDE.md"), `see @${join(g, "shared.md")}`);

  const files = withGlobalDir(g, () => buildInstructionGraph(proj).files);
  const shared = files.find((f) => f.path === join(g, "shared.md"));
  expect(shared?.global).toBe(false);
  expect(shared?.outOfTree).toBe(true);
});

test("no global dir contents means no global files", () => {
  const proj = normalizeProjectDir(mkdtempSync(join(tmpdir(), "affirm-gproj-none-")));
  writeFileSync(join(proj, "CLAUDE.md"), "project root");
  const files = buildInstructionGraph(proj).files;
  expect(files.map((f) => f.global)).toEqual([false]);
});
