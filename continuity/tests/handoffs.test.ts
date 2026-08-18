import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, formatHeader, generation, main, ownership, report, stamp } from "../lib/handoffs";

// --- wrap-generation stamp -------------------------------------------------

const BODY = "# Next session — proj\n\n## Open threads\n- [ ] a thing\n";

test("a stamped file reads as assistant-owned", () => {
  expect(ownership(stamp(BODY))).toBe("assistant");
});

test("stamping is idempotent — re-stamping unchanged content is a no-op", () => {
  expect(stamp(stamp(BODY))).toBe(stamp(BODY));
});

test("content changed after stamping reads as edited", () => {
  expect(ownership(stamp(BODY) + "- [ ] user added this\n")).toBe("edited");
});

test("a file with no stamp reads as unstamped", () => {
  expect(ownership(BODY)).toBe("unstamped");
});

test("the stamp does not depend on trailing whitespace", () => {
  expect(generation(BODY)).toBe(generation(BODY + "\n\n  \n"));
});

test("different content produces a different generation", () => {
  expect(generation(BODY)).not.toBe(generation(BODY + "- [ ] another\n"));
});

// --- collect / report ------------------------------------------------------

function fixture(): { root: string; sub: string } {
  const root = mkdtempSync(join(tmpdir(), "handoffs-"));
  writeFileSync(join(root, "CLAUDE.md"), "# marker\n");
  mkdirSync(join(root, "sub"));

  writeFileSync(join(root, "NEXT_SESSION.md"),
    "# Next session — proj\n\n**Last wrapped:** 2026-08-16T22:45:00-05:00 (session 3367fcc4)\n\n## Open threads\n- [ ] old\n");
  writeFileSync(join(root, "sub", "NEXT_SESSION.md"),
    "# Next session — sub\n\n**Last wrapped:** 2026-08-18T09:00:00-05:00 (session deadbeef)\n\n## Open threads\n- [ ] new\n");

  // The failure this file exists to prevent: the cwd-local pointer is the OLD one.
  const old = Date.parse("2026-08-16T22:45:00-05:00") / 1000;
  const fresh = Date.parse("2026-08-18T09:00:00-05:00") / 1000;
  utimesSync(join(root, "NEXT_SESSION.md"), old, old);
  utimesSync(join(root, "sub", "NEXT_SESSION.md"), fresh, fresh);
  return { root, sub: join(root, "sub") };
}

test("collect returns newest first and flags the cwd-local file", () => {
  const { root } = fixture();
  const hs = collect(root, root);
  expect(hs.map(h => h.rel)).toEqual(["sub/NEXT_SESSION.md", "NEXT_SESSION.md"]);
  expect(hs[0].local).toBe(false);
  expect(hs[1].local).toBe(true);
  expect(hs[0].wrapped).toBe("2026-08-18T09:00:00-05:00");
});

test("report names the gap when the local pointer is not the newest", () => {
  const { root } = fixture();
  const now = Date.parse("2026-08-18T10:00:00-05:00");
  const lines = report(collect(root, root), root, now).split("\n");
  expect(lines[0]).toContain("2 handoffs");
  expect(lines[0]).toContain("local is 1d 10h staler than newest");
  expect(lines[1].startsWith("* sub/NEXT_SESSION.md")).toBe(true);
  expect(lines[2]).toContain("[local]");
});

test("report says so when the cwd has no pointer of its own", () => {
  const { root, sub } = fixture();
  const out = report(collect(join(root, "other"), root), root, Date.now());
  expect(out.split("\n")[0]).toContain("· none in cwd");
  expect(sub).toContain("sub"); // fixture sanity
});

test("report on a single local pointer carries no staleness pivot", () => {
  const root = mkdtempSync(join(tmpdir(), "handoffs-"));
  writeFileSync(join(root, "CLAUDE.md"), "# marker\n");
  writeFileSync(join(root, "NEXT_SESSION.md"), BODY);
  const out = report(collect(root, root), root, Date.now());
  expect(out.split("\n")[0]).toBe(`1 handoff · root ${root}`);
  expect(out).toContain("no header");
});

test("report on an empty project states the count rather than staying silent", () => {
  const root = mkdtempSync(join(tmpdir(), "handoffs-"));
  writeFileSync(join(root, "CLAUDE.md"), "# marker\n");
  expect(report(collect(root, root), root, Date.now())).toBe(`0 handoffs · root ${root}`);
});

// --- CLI -------------------------------------------------------------------

test("--stamp then --check round-trips through the filesystem", () => {
  const root = mkdtempSync(join(tmpdir(), "handoffs-"));
  const path = join(root, "NEXT_SESSION.md");
  writeFileSync(path, BODY);

  const out: string[] = [];
  expect(main(["--check", path], Date.now(), s => void out.push(s))).toBe(0);
  expect(main(["--stamp", path], Date.now(), s => void out.push(s))).toBe(0);
  expect(main(["--check", path], Date.now(), s => void out.push(s))).toBe(0);
  expect(out[0]).toBe("unstamped");
  expect(out[1]).toStartWith("stamped ");
  expect(out[2]).toBe("assistant");
});

test("--check on a missing file exits 0 and says absent", () => {
  const out: string[] = [];
  expect(main(["--check", "/nope/NEXT_SESSION.md"], Date.now(), s => void out.push(s))).toBe(0);
  expect(out[0]).toStartWith("absent ");
});

test("an unknown flag exits 2", () => {
  expect(main(["--bogus"], Date.now(), () => {})).toBe(2);
});

// --- formatHeader ----------------------------------------------------------
// The header is the one part of NEXT_SESSION.md that code parses back, so the
// renderer and LAST_WRAPPED have to agree. These pin them to each other.

test("formatHeader renders a header collect() can parse back", () => {
  const root = mkdtempSync(join(tmpdir(), "handoffs-"));
  writeFileSync(join(root, "CLAUDE.md"), "# marker\n");
  const header = formatHeader({
    slug: "enfurbish",
    wrapped: "2026-08-18T21:00:00-05:00",
    session: "204f692f",
    retro: "~/.claude/sessions/2026-08-18-enfurbish-204f692f.md",
  });
  writeFileSync(join(root, "NEXT_SESSION.md"), `${header}\n\n## Open threads\n- [ ] a thing\n`);
  expect(collect(root, root)[0].wrapped).toBe("2026-08-18T21:00:00-05:00");
});

test("formatHeader marks a quick wrap as having no retro", () => {
  expect(formatHeader({ slug: "x", wrapped: "2026-08-18T00:00:00Z", session: "abc12345" }))
    .toContain("**Retro:** none (-q)");
});

test("--header requires slug, timestamp and session", () => {
  expect(main(["--header", "enfurbish"], Date.now(), () => {})).toBe(2);
});
