import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

test("no-arg (affirm) records hashes for all instruction files", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const io = collect();
  const code = runCli([], opts(dir, hashPath, io));
  expect(code).toBe(0);
  expect(io.out.join("\n")).toContain("Affirmed 1 file");
  expect(loadHashes(hashPath)[join(dir, "CLAUDE.md")]).toBe(sha256OfFile(join(dir, "CLAUDE.md")));
});

test("--show reports NEW for unaffirmed and affirmed for matching", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  writeFileSync(join(dir, ".claude", "rules", "x.md"), "x");

  // Pre-affirm CLAUDE.md only
  saveHashes({ [join(dir, "CLAUDE.md")]: sha256OfFile(join(dir, "CLAUDE.md")) }, hashPath);

  const io = collect();
  runCli(["--show"], opts(dir, hashPath, io));
  const out = io.out.join("\n");
  expect(out).toContain("CLAUDE.md  [affirmed]");
  expect(out).toMatch(/x\.md\s+\[NEW \(not yet affirmed\)\]/);
});

test("--show reports CHANGED after file mutation", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "v1");
  saveHashes({ [join(dir, "CLAUDE.md")]: sha256OfFile(join(dir, "CLAUDE.md")) }, hashPath);
  writeFileSync(join(dir, "CLAUDE.md"), "v2");

  const io = collect();
  runCli(["--show"], opts(dir, hashPath, io));
  expect(io.out.join("\n")).toContain("[CHANGED (hash mismatch)]");
});

test("--revoke removes affirmations for this project only", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  saveHashes({
    [join(dir, "CLAUDE.md")]: sha256OfFile(join(dir, "CLAUDE.md")),
    "/other/proj/CLAUDE.md": "deadbeef",
  }, hashPath);

  const io = collect();
  runCli(["--revoke"], opts(dir, hashPath, io));
  expect(io.out.join("\n")).toContain("Revoked 1 affirmation");
  expect(loadHashes(hashPath)).toEqual({ "/other/proj/CLAUDE.md": "deadbeef" });
});

test("--revoke reports no-op when nothing was affirmed", () => {
  const { dir, hashPath } = mkProject();
  writeFileSync(join(dir, "CLAUDE.md"), "rules");
  const io = collect();
  runCli(["--revoke"], opts(dir, hashPath, io));
  expect(io.out.join("\n")).toContain("No prior affirmations to revoke");
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
