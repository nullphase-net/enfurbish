import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "..", "lib", "journal-append.ts");
const HEADER_MATCH = "# Claude Code tooling journal";

function run(journal: string, entryStdin: string) {
  return spawnSync("bun", ["run", SCRIPT, "--journal", journal], {
    encoding: "utf8",
    input: entryStdin,
  });
}

test("initializes journal with header on first run", () => {
  const dir = mkdtempSync(join(tmpdir(), "journal-"));
  const journal = join(dir, "tooling-journal.md");
  const entry = "## 2026-05-10T17:00:00Z  •  test  •  abc12345\n\n### x  •  used 1  •  verdict: helped\n- ok\n\n---\n";

  const res = run(journal, entry);
  expect(res.status).toBe(0);

  const content = readFileSync(journal, "utf8");
  expect(content).toContain(HEADER_MATCH);
  expect(content).toContain("### x  •  used 1  •  verdict: helped");
  expect(content.indexOf(HEADER_MATCH)).toBeLessThan(content.indexOf("### x"));
});

test("appends to existing journal without re-adding header", () => {
  const dir = mkdtempSync(join(tmpdir(), "journal-"));
  const journal = join(dir, "tooling-journal.md");
  writeFileSync(journal, "# Claude Code tooling journal\n\nblah\n\n---\n\n## prior entry\n");

  const res = run(journal, "## new entry\n- new\n");
  expect(res.status).toBe(0);

  const content = readFileSync(journal, "utf8");
  const headerCount = (content.match(/# Claude Code tooling journal/g) ?? []).length;
  expect(headerCount).toBe(1);
  expect(content).toContain("## prior entry");
  expect(content).toContain("## new entry");
  expect(content.indexOf("## prior entry")).toBeLessThan(content.indexOf("## new entry"));
});

test("uses temp+rename so journal is never half-written", () => {
  const dir = mkdtempSync(join(tmpdir(), "journal-"));
  const journal = join(dir, "tooling-journal.md");
  const big = "## entry\n" + "x".repeat(50_000) + "\n";
  const res = run(journal, big);
  expect(res.status).toBe(0);
  const content = readFileSync(journal, "utf8");
  expect(content.endsWith(big.slice(-100))).toBe(true);
  const fs = require("node:fs");
  const leftovers = fs.readdirSync(dir).filter((n: string) => n.includes(".tmp"));
  expect(leftovers.length).toBe(0);
});

test("no-op on empty stdin (don't truncate journal)", () => {
  const dir = mkdtempSync(join(tmpdir(), "journal-"));
  const journal = join(dir, "tooling-journal.md");
  writeFileSync(journal, "# Claude Code tooling journal\n\nfoo\n");
  const res = run(journal, "");
  expect(res.status).toBe(0);
  expect(readFileSync(journal, "utf8")).toContain("foo");
});
