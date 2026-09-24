import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECK_RESULTS, checkReport, collect, commitsSince, formatHeader, generation, main, ownership, ownershipSince, report, stamp, windowSince } from "../lib/handoffs";
import { spawnSync } from "node:child_process";
import { gitInitClean } from "./helpers/git";

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

// --- edited, split on when -------------------------------------------------
// Both directions, because a probe asserted one way cannot fail. `during` is
// the case that was always handled; `prior` is the one that had no branch and
// got handled as `during` by default.

const EDITED = stamp(BODY) + "- [ ] someone added this\n";
const START = "2026-09-18T12:00:00Z";
const START_MS = Date.parse(START);

test("edited during the session splits as edited:during", () => {
  expect(ownershipSince(EDITED, START_MS + 60_000, START)).toBe("edited:during");
});

test("edited before the session splits as edited:prior", () => {
  expect(ownershipSince(EDITED, START_MS - 60_000, START)).toBe("edited:prior");
});

test("mtime exactly at session_start counts as during", () => {
  expect(ownershipSince(EDITED, START_MS, START)).toBe("edited:during");
});

test("the split leaves assistant alone — a stamp match needs no clock", () => {
  expect(ownershipSince(stamp(BODY), START_MS - 60_000, START)).toBe("assistant");
  expect(ownershipSince(stamp(BODY), START_MS + 60_000, START)).toBe("assistant");
});

test("unstamped splits on the same test, both directions", () => {
  expect(ownershipSince(BODY, START_MS + 60_000, START)).toBe("unstamped:during");
  expect(ownershipSince(BODY, START_MS - 60_000, START)).toBe("unstamped:prior");
});

test("an unparseable session_start returns the unsplit answer rather than guessing", () => {
  expect(ownershipSince(EDITED, START_MS - 60_000, "not a date")).toBe("edited");
  expect(ownershipSince(BODY, START_MS - 60_000, "not a date")).toBe("unstamped");
});

test("--check without a since argument still answers the old three", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-check-"));
  const path = join(dir, "NEXT_SESSION.md");
  writeFileSync(path, EDITED);
  const out: string[] = [];
  expect(main(["--check", path], Date.now(), s => void out.push(s))).toBe(0);
  expect(out[0].split("\n")[0]).toBe("edited");
});

test("--check with a since argument reports edited:prior for a dead session's pointer", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-check-"));
  const path = join(dir, "NEXT_SESSION.md");
  writeFileSync(path, EDITED);
  const old = new Date(START_MS - 3600_000);
  utimesSync(path, old, old);
  const out: string[] = [];
  expect(main(["--check", path, START], Date.now(), s => void out.push(s))).toBe(0);
  expect(out[0].split("\n")[0]).toBe("edited:prior");
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

// A header 5h in the future is what a wrap wrote here on 2026-09-14 — UTC clock-time
// carrying a CDT offset. `report` printed the age and the header side by side and
// compared neither, so the line read as healthy and `--since` under-reported off it.
test("report says so when the header postdates the file it heads", () => {
  const root = mkdtempSync(join(tmpdir(), "handoffs-"));
  writeFileSync(join(root, "CLAUDE.md"), "# marker\n");
  const p = join(root, "NEXT_SESSION.md");
  writeFileSync(p, "# Next session — proj\n\n**Last wrapped:** 2026-08-18T14:00:00-05:00 (session abc12345)\n");
  const t = Date.parse("2026-08-18T09:00:00-05:00") / 1000;
  utimesSync(p, t, t);
  const out = report(collect(root, root), root, Date.parse("2026-08-18T10:00:00-05:00"));
  expect(out).toContain("header 5h ahead of file");
  expect(out).not.toContain("after header");
});

// The other direction of the same comparison: a file that moved after its header is
// a mid-session reconcile, which is normal and reads differently.
test("report distinguishes a file edited after its header from a header ahead of its file", () => {
  const root = mkdtempSync(join(tmpdir(), "handoffs-"));
  writeFileSync(join(root, "CLAUDE.md"), "# marker\n");
  const p = join(root, "NEXT_SESSION.md");
  writeFileSync(p, "# Next session — proj\n\n**Last wrapped:** 2026-08-18T09:00:00-05:00 (session abc12345)\n");
  const t = Date.parse("2026-08-18T14:00:00-05:00") / 1000;
  utimesSync(p, t, t);
  const out = report(collect(root, root), root, Date.parse("2026-08-18T15:00:00-05:00"));
  expect(out).toContain("+5h after header");
  expect(out).not.toContain("ahead of file");
});

// `/next` was told to summarize aggressively past 16 KB; `/wrap`, which writes the
// file, was told nothing. One reached 70 KB. The marker rides the report both read.
test("report marks a pointer past 16KB and stays quiet under it", () => {
  const root = mkdtempSync(join(tmpdir(), "handoffs-"));
  writeFileSync(join(root, "CLAUDE.md"), "# marker\n");
  const p = join(root, "NEXT_SESSION.md");

  writeFileSync(p, "x".repeat(16 * 1024));
  expect(report(collect(root, root), root, Date.now())).not.toContain("oversize");

  writeFileSync(p, "x".repeat(16 * 1024 + 1));
  expect(report(collect(root, root), root, Date.now())).toContain("oversize:16KB");

  writeFileSync(p, "x".repeat(70 * 1024));
  expect(report(collect(root, root), root, Date.now())).toContain("oversize:70KB");
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
  expect(out[0].split("\n")[0]).toBe("unstamped");
  expect(out[1]).toStartWith("stamped ");
  expect(out[2].split("\n")[0]).toBe("assistant");
});

// symbion 55a: `--stamp` certified content without moving the header above it, so a
// mid-session reconcile that stamped (as 5.6 says to) read `+Nm after header` on the
// next report — a false positive the reader then had to explain away. A normal wrap
// could earn one too: --header renders before the body is composed.
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

function reconciled(wrappedMs: number): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "handoffs-"));
  writeFileSync(join(root, "CLAUDE.md"), "# marker\n");
  const path = join(root, "NEXT_SESSION.md");
  const header = formatHeader({ slug: "proj", wrapped: iso(wrappedMs), session: "abc12345" });
  writeFileSync(path, `${header}\n\n## Open threads\n- [ ] a thing\n`);
  return { root, path };
}

test("--stamp moves the header to the stamp when it certifies new content", () => {
  const now = Date.now();
  const { root, path } = reconciled(now - 2 * 3600_000);
  main(["--stamp", path], now, () => {});
  const text = readFileSync(path, "utf8");
  expect(text).toContain(`**Last wrapped:** ${iso(now)} (session abc12345)`);
  expect(ownership(text)).toBe("assistant");
  expect(report(collect(root, root), root, now)).not.toContain("after header");
});

// The other direction. Moving the header opens the next `--since` window later; doing
// it for content nobody rewrote would hide commits the file was never reconciled against.
test("--stamp leaves the header alone when the content has not moved since the last stamp", () => {
  const t1 = Date.now() - 3600_000;
  const { path } = reconciled(t1 - 60_000);
  main(["--stamp", path], t1, () => {});
  const once = readFileSync(path, "utf8");
  main(["--stamp", path], t1 + 3000_000, () => {});
  expect(readFileSync(path, "utf8")).toBe(once);
  expect(once).toContain(`**Last wrapped:** ${iso(t1)}`);
});

test("--stamp on a file with no header stamps it and adds nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "handoffs-"));
  const path = join(root, "NEXT_SESSION.md");
  writeFileSync(path, BODY);
  main(["--stamp", path], Date.now(), () => {});
  expect(readFileSync(path, "utf8")).toBe(stamp(BODY));
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

test("--header requires slug and session", () => {
  expect(main(["--header", "enfurbish"], Date.now(), () => {})).toBe(2);
});

// The timestamp is not an argument and cannot be one. A model composed it from
// memory and produced UTC clock-time wearing a CDT offset — 5h fast — which every
// window downstream then derived from, silently short by the error.
test("--header stamps the clock rather than accepting a timestamp", () => {
  const out: string[] = [];
  const now = Date.parse("2026-09-14T10:05:00Z");
  expect(main(["--header", "enfurbish", "204f692f"], now, s => void out.push(s))).toBe(0);
  expect(out[0]).toContain("**Last wrapped:** 2026-09-14T10:05:00Z (session 204f692f)");
  expect(out[0]).toContain("**Retro:** none (-q)");

  // The third positional is the retro path, not a timestamp — a caller still typing
  // the old four-arg form would otherwise land its ISO string in the session slot.
  out.length = 0;
  main(["--header", "enfurbish", "204f692f", "~/r.md"], now, s => void out.push(s));
  expect(out[0]).toContain("(session 204f692f)");
  expect(out[0]).toContain("**Retro:** ~/r.md");
});

// --- commitsSince ----------------------------------------------------------

function repoWithCommits(dates: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "handoffs-git-"));
  const fx = gitInitClean(root);
  try {
    for (const iso of dates) {
      writeFileSync(join(root, "f.txt"), iso);
      spawnSync("git", ["add", "-A"], { cwd: root });
      spawnSync("git", ["commit", "-q", "-m", iso], {
        cwd: root,
        env: { ...process.env, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso },
      });
    }
  } finally {
    fx.cleanup();
  }
  return root;
}

const COMMITS = [
  "2026-08-18T16:00:00-05:00",
  "2026-08-18T18:00:00-05:00",
  "2026-08-18T19:00:00-05:00",
];

test("commitsSince counts only the commits that postdate the header", () => {
  const root = repoWithCommits(COMMITS);
  expect(commitsSince(root, "2026-08-18T17:00:00-05:00")).toBe(2);
  expect(commitsSince(root, "2026-08-18T15:00:00-05:00")).toBe(3);
});

test("commitsSince is 0, not null, when the handoff is current with the repo", () => {
  const root = repoWithCommits(COMMITS);
  expect(commitsSince(root, "2026-08-18T20:00:00-05:00")).toBe(0);
});

test("commitsSince is null when it cannot tell — no repo, no header, bad header", () => {
  const root = repoWithCommits(COMMITS);
  const bare = mkdtempSync(join(tmpdir(), "handoffs-nogit-"));
  expect(commitsSince(bare, "2026-08-18T17:00:00-05:00")).toBe(null);
  expect(commitsSince(root, null)).toBe(null);
  expect(commitsSince(root, "no header")).toBe(null);
});

// Age measures the file; this measures the repo it describes. A 2026-08-18
// session briefed from an accurately-reported 2h52m-old pointer that 14 commits
// had already obsoleted.
test("report names the commits that postdate the newest handoff", () => {
  const root = repoWithCommits(COMMITS);
  writeFileSync(join(root, "NEXT_SESSION.md"),
    "# Next session — proj\n\n**Last wrapped:** 2026-08-18T17:00:00-05:00 (session deadbeef)\n\n## Open threads\n- [ ] a thing\n");
  const out = report(collect(root, root), root, Date.parse("2026-08-18T20:00:00-05:00"));
  expect(out.split("\n")[0]).toContain("newest 2 commits behind");
  expect(out.split("\n")[1]).toContain("+2 commits");
});

test("report stays silent about commits when the handoff is current", () => {
  const root = repoWithCommits(COMMITS);
  writeFileSync(join(root, "NEXT_SESSION.md"),
    "# Next session — proj\n\n**Last wrapped:** 2026-08-18T20:00:00-05:00 (session deadbeef)\n\n## Open threads\n- [ ] a thing\n");
  const out = report(collect(root, root), root, Date.parse("2026-08-18T21:00:00-05:00"));
  expect(out).not.toContain("commit");
});

// --- windowSince: the evidence for "which of these are already done?" -------

const HANDOFF = (iso: string) =>
  `# Next session — proj\n\n**Last wrapped:** ${iso} (session deadbeef)\n\n## Open threads\n- [ ] a thing\n`;

test("windowSince names the commits and files that landed after the header", () => {
  const root = repoWithCommits(COMMITS);
  const p = join(root, "NEXT_SESSION.md");
  writeFileSync(p, HANDOFF("2026-08-18T17:00:00-05:00"));
  const out = windowSince(root, p);
  expect(out).toContain("2 commits");
  expect(out).toContain("2026-08-18T18:00:00-05:00");
  expect(out).toContain("2026-08-18T19:00:00-05:00");
  expect(out).not.toContain("2026-08-18T16:00:00-05:00");
  expect(out).toContain("files: f.txt");
});

// The other direction: a current handoff must read as an all-clear, not as silence.
test("windowSince says 0 and says the handoff still describes HEAD", () => {
  const root = repoWithCommits(COMMITS);
  const p = join(root, "NEXT_SESSION.md");
  writeFileSync(p, HANDOFF("2026-08-18T20:00:00-05:00"));
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "handoff"], {
    cwd: root,
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-08-18T19:30:00-05:00", GIT_AUTHOR_DATE: "2026-08-18T19:30:00-05:00" },
  });
  const out = windowSince(root, p);
  expect(out).toContain("0 commits");
  expect(out).toContain("still describes HEAD");
  expect(out).not.toContain("uncommitted");
});

// This repo's own case on 2026-09-08: 0 commits since the header and 8 dirty
// files. "Still describes HEAD" would have been the wrong answer.
test("windowSince counts uncommitted work, which is what an unwrapped session leaves", () => {
  const root = repoWithCommits(COMMITS);
  const p = join(root, "NEXT_SESSION.md");
  writeFileSync(p, HANDOFF("2026-08-18T20:00:00-05:00"));
  writeFileSync(join(root, "f.txt"), "edited after the wrap, never committed");
  const out = windowSince(root, p);
  expect(out).toContain("0 commits");
  expect(out).toContain("1 uncommitted");
  expect(out).toContain("predates uncommitted work");
  expect(out).not.toContain("still describes HEAD");
});

// The wrap writes the pointer after rendering its header, so the pointer is
// always newer than its own timestamp. Counted, it read as "1 uncommitted —
// handoff predates uncommitted work" on every fresh wrap (two in a row on
// 2026-09-10), and the all-clear could never appear. The previous test used
// to pass on exactly that self-count.
test("windowSince does not count the handoff itself as work it predates", () => {
  const root = repoWithCommits(COMMITS);
  const p = join(root, "NEXT_SESSION.md");
  writeFileSync(p, HANDOFF("2026-08-18T20:00:00-05:00"));
  const out = windowSince(root, p);
  expect(out).toContain("0 commits");
  expect(out).toContain("still describes HEAD");
  expect(out).not.toContain("uncommitted");
});

// The measured cost of trusting one: a header 5h fast reported 3 commits where 11
// had landed. `--header` can no longer write one, but files that already carry one
// are on disk, and a short window reads exactly like a correct one.
test("windowSince refuses a header that postdates now", () => {
  const root = repoWithCommits(COMMITS);
  const p = join(root, "NEXT_SESSION.md");
  writeFileSync(p, HANDOFF("2099-01-01T00:00:00Z"));
  const out = windowSince(root, p);
  expect(out).toContain("window unknown");
  expect(out).toContain("postdates now");
});

test("windowSince refuses rather than guesses — absent file, no header, no repo", () => {
  const root = repoWithCommits(COMMITS);
  const bare = mkdtempSync(join(tmpdir(), "handoffs-nogit-"));
  expect(windowSince(root, join(root, "nope.md"))).toContain("absent");

  const noHeader = join(root, "NEXT_SESSION.md");
  writeFileSync(noHeader, "# Next session\n\n## Open threads\n- [ ] a thing\n");
  expect(windowSince(root, noHeader)).toContain("window unknown");

  const outside = join(bare, "NEXT_SESSION.md");
  writeFileSync(outside, HANDOFF("2026-08-18T17:00:00-05:00"));
  expect(windowSince(bare, outside)).toContain("window unknown");
});

test("--since requires a path", () => {
  expect(main(["--since"], Date.now(), () => {})).toBe(2);
});

// `report` prints paths relative to the project root, and next/SKILL.md tells the
// model to hand that path straight to --since. Resolving it against cwd returned
// `absent` from every subdirectory session — a refusal that reads as "no handoff".
function inDir<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(prev); }
}

test("--since resolves the root-relative path report printed, from a subdirectory", () => {
  const root = repoWithCommits(COMMITS);
  writeFileSync(join(root, "NEXT_SESSION.md"), HANDOFF("2026-08-18T17:00:00-05:00"));
  mkdirSync(join(root, "sub"), { recursive: true });

  let out = "";
  const code = inDir(join(root, "sub"), () =>
    main(["--since", "NEXT_SESSION.md"], Date.now(), s => { out = s; }));
  expect(code).toBe(0);
  expect(out).not.toContain("absent");
  expect(out).toContain("2 commits");
});

// The other direction: a path that does exist relative to cwd must still win, or the
// fallback would silently answer about a different file than the one you named.
test("--since prefers a cwd-relative path over the same name at the root", () => {
  const root = repoWithCommits(COMMITS);
  writeFileSync(join(root, "NEXT_SESSION.md"), HANDOFF("2026-08-18T17:00:00-05:00"));
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub", "NEXT_SESSION.md"), HANDOFF("2026-08-18T20:00:00-05:00"));

  let out = "";
  inDir(join(root, "sub"), () =>
    main(["--since", "NEXT_SESSION.md"], Date.now(), s => { out = s; }));
  expect(out).toContain("0 commits");
  expect(out).not.toContain("2 commits");
});

// `git log` exits non-zero on an initialised repo with no commits too. Same class of
// answer, different fact — reporting the wrong one sends the reader hunting a .git
// that is right there.
test("windowSince tells a commitless repo apart from no repo at all", () => {
  const empty = mkdtempSync(join(tmpdir(), "handoffs-empty-"));
  spawnSync("git", ["init", "-q", empty]);
  const p = join(empty, "NEXT_SESSION.md");
  writeFileSync(p, HANDOFF("2026-08-18T17:00:00-05:00"));
  const out = windowSince(empty, p);
  expect(out).toContain("no commits yet");
  expect(out).toContain("window unknown");
  expect(out).not.toContain("not a git repo");
});

// --- --check guidance ------------------------------------------------------
// The verdict token stays alone on line one. Line two says what to do with it,
// so the skill carries one sentence instead of a table of seven states that the
// model loads on every wrap and needs exactly one of. One case per state: a
// fixture that models one shape proves that shape and passes forever.

test("checkReport puts the verdict alone on line one and guidance on line two, for every state", () => {
  expect(CHECK_RESULTS.length).toBe(7);   // three verdicts, two of them split two ways
  for (const s of CHECK_RESULTS) {
    const lines = checkReport(s).split("\n");
    expect(lines[0]).toBe(s);
    expect(lines.length).toBe(2);
    expect(lines[1]).toStartWith("  ");
    expect(lines[1].trim()).not.toBe("");
    expect(lines[1]).not.toContain("undefined");   // a state with no GUIDANCE entry renders as this
  }
});

test("guidance pivots on state: prior and assistant merge, during preserves and names the transcript, unsplit re-runs then falls back to preserve", () => {
  for (const s of ["assistant", "edited:prior", "unstamped:prior"] as const) {
    expect(checkReport(s)).toMatch(/\bmerge\b/i);
    expect(checkReport(s)).not.toMatch(/preserve/i);
  }
  for (const s of ["edited:during", "unstamped:during"] as const) {
    expect(checkReport(s)).toMatch(/preserve/i);
    expect(checkReport(s)).toMatch(/transcript/);
    expect(checkReport(s)).not.toMatch(/\bmerge\b/i);
  }
  for (const s of ["edited", "unstamped"] as const) {
    expect(checkReport(s)).toMatch(/re-run/i);
    expect(checkReport(s)).toMatch(/no session_start.*preserve/i);   // the degraded-scan fallback
    expect(checkReport(s)).not.toMatch(/\bmerge\b/i);
  }
});

test("--check emits the guidance beneath the verdict as one message", () => {
  const dir = mkdtempSync(join(tmpdir(), "handoff-check-"));
  const path = join(dir, "NEXT_SESSION.md");
  writeFileSync(path, EDITED);
  const old = new Date(START_MS - 3600_000);
  utimesSync(path, old, old);
  const out: string[] = [];
  expect(main(["--check", path, START], Date.now(), s => void out.push(s))).toBe(0);
  expect(out).toEqual([checkReport("edited:prior")]);
});
