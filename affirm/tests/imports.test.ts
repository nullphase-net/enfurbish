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
    { path: join(dir, "CLAUDE.md"), depth: 0, via: null, outOfTree: false },
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

test("graph: follows imports to depth 2, summarizes deeper", () => {
  const dir = mkProj();
  writeFileSync(join(dir, "CLAUDE.md"), "@a.md");
  writeFileSync(join(dir, "a.md"), "@b.md"); // depth 1
  writeFileSync(join(dir, "b.md"), "@c.md"); // depth 2
  writeFileSync(join(dir, "c.md"), "deep"); // depth 3 — not followed
  const g = buildInstructionGraph(dir);
  const paths = g.files.map((f) => f.path);
  expect(paths).toContain(join(dir, "b.md"));
  expect(paths).not.toContain(join(dir, "c.md"));
  expect(g.deep).toEqual([{ via: join(dir, "b.md"), raw: "c.md" }]);
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

test("MAX_IMPORT_DEPTH is 2", () => {
  expect(MAX_IMPORT_DEPTH).toBe(2);
});
