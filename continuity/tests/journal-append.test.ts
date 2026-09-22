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

// --- arg validation --------------------------------------------------------
// `--recent` with no value parsed to "", which `matching()` reads as "no
// filter": a flag asking about one tool reported all 731 sections. Both
// directions are asserted — the empty value must fail AND a real one must still
// work — because a guard that rejects everything reads as working too.

function cli(journal: string, ...args: string[]) {
  return spawnSync("bun", ["run", SCRIPT, "--journal", journal, ...args], { encoding: "utf8" });
}

const SECTIONS = `${HEADER_MATCH}

## 2026-09-18T10:00:00Z  •  proj  •  abcd1234

### pastiche (SessionStart hook)  •  1 fire  •  verdict: helped
- a note
- Action: do the thing

### continuity:wrap (skill)  •  1 scan  •  verdict: helped
- another note
`;

function seeded(): string {
  const j = join(mkdtempSync(join(tmpdir(), "journal-args-")), "journal.md");
  writeFileSync(j, SECTIONS);
  return j;
}

test("--recent with no value is arg misuse, not a wildcard over the whole journal", () => {
  const r = cli(seeded(), "--recent");
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("--recent needs a tool name");
  expect(r.stdout).not.toContain("sections");
});

test("--recent with a whitespace-only value is rejected the same way", () => {
  expect(cli(seeded(), "--recent", "   ").status).toBe(2);
});

test("--recent with a real tool name still reports", () => {
  const r = cli(seeded(), "--recent", "pastiche");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("pastiche");
});

test("--actions takes no value and is unaffected by the guard", () => {
  const r = cli(seeded(), "--actions");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("do the thing");
});

// --- stale guidance --------------------------------------------------------
// The `stale:` block has a job attached: answer each row as open, done, or never,
// and retire it through `closed`. The instruction sits beside the rows it is
// about, and only when there are rows, so the skill does not carry it on wraps
// with nothing stale. Both directions: present with a stale block, absent without.

const MANY = `${HEADER_MATCH}

## 2026-09-01T10:00:00Z  •  proj  •  aaaa1111

### toolA  •  verdict: neutral
- Action: oldest idea

## 2026-09-02T10:00:00Z  •  proj  •  bbbb2222

### toolB  •  verdict: neutral
- Action: middle idea

## 2026-09-03T10:00:00Z  •  proj  •  cccc3333

### toolC  •  verdict: neutral
- Action: newest idea
`;

function manyActions(): string {
  const j = join(mkdtempSync(join(tmpdir(), "journal-stale-")), "journal.md");
  writeFileSync(j, MANY);
  return j;
}

test("--actions prints one guidance line under stale: when the block has rows", () => {
  const r = cli(manyActions(), "--actions", "--limit", "1");
  expect(r.status).toBe(0);
  const lines = r.stdout.trimEnd().split("\n");
  const at = lines.indexOf("stale:");
  expect(at).toBeGreaterThan(0);
  const guidance = lines[at + 1];
  expect(guidance).toMatch(/still open/);
  expect(guidance).toMatch(/closed/);
  expect(guidance).not.toMatch(/^\d{4}-\d{2}-\d{2}/);   // not a row
  expect(lines.length).toBeGreaterThan(at + 2);   // without this the every() below is vacuous
  expect(lines.slice(at + 2).every(l => /^\d{4}-\d{2}-\d{2}/.test(l))).toBe(true);   // rows follow it
});

test("--actions prints no stale block and no guidance when everything fits the head", () => {
  const r = cli(manyActions(), "--actions", "--limit", "20");
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain("stale:");
  expect(r.stdout).not.toMatch(/still open/);
});
