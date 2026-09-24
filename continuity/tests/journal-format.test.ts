import { test, expect } from "bun:test";
import {
  findActions, findClosed, formatEntry, matching, parseSections, reportActions, reportRecent,
} from "../lib/journal-append";

// The journal's shape used to live only in wrap/SKILL.md prose. These pin the
// renderer to the readers: what formatEntry writes, parseSections must find.

const ENTRY = {
  timestamp: "2026-08-18T21:00:00-05:00",
  slug: "enfurbish",
  session: "204f692f",
  arc: "mined the journal, fixed the scan.ts undercount",
  tools: [
    {
      name: "continuity scan.ts",
      usage: "3 runs",
      verdict: "helped",
      notes: ["turn_count.user root-caused: bare-string content was never counted."],
      action: "none — closed after six loggings.",
    },
    { name: "pastiche CLI", usage: "2 invocations", verdict: "helped" },
  ],
};

test("formatEntry uses the separator already on disk", () => {
  const lines = formatEntry(ENTRY).split("\n");
  expect(lines[0]).toBe("## 2026-08-18T21:00:00-05:00  •  enfurbish  •  204f692f");
  expect(lines[2]).toBe("**Session arc:** mined the journal, fixed the scan.ts undercount");
  expect(lines[4]).toBe("### continuity scan.ts  •  3 runs  •  verdict: helped");
});

test("formatEntry omits the Action line when there is no action", () => {
  const secs = parseSections(formatEntry(ENTRY));
  expect(secs.map(s => s.tool)).toEqual(["continuity scan.ts", "pastiche CLI"]);
  expect(findActions(secs)).toHaveLength(1);
});

test("what formatEntry writes, parseSections reads back", () => {
  const secs = parseSections(formatEntry(ENTRY));
  expect(secs[0].entry).toBe("2026-08-18T21:00:00-05:00");
  expect(findActions(secs)[0].text).toBe("none — closed after six loggings.");
});

// --- the drift the readers exist to survive --------------------------------
// Every heading and Action spelling below is copied from the real journal.

const DRIFTED = [
  "## 2026-08-14T00:18:00-05:00  •  topologicat  •  0a4ddd46",
  "",
  "### continuity scan.ts  •  1 run  •  verdict: helped",
  "- Action: count command-wrapped user events as user turns.",
  "",
  "### Hook: SessionStart (continuity)  •  8 fires  •  verdict: hurt",
  "- Action (recurring, unmoved): dedupe SessionStart injections per session_id.",
  "",
  "### hook: SessionStart (ponytail + continuity + pastiche)  •  fired 7x  •  verdict: helped",
  "- **Action (new):** put the graphify binary on a PATH non-interactive shells see.",
  "",
  "### continuity:wrap (step-5 mtime rule)  •  1 wrap  •  verdict: neutral",
  "- Action (10th repetition): drop the mtime heuristic for an explicit marker.",
  "",
  "### pastiche CLI  •  4 invocations  •  verdict: helped",
  "- No action here.",
].join("\n");

test("a loose tool match reaches every heading spelling a strict grep misses", () => {
  const secs = parseSections(DRIFTED);
  // `grep '^### continuity'` reaches 2 of these 4; the point is that we reach all 4.
  expect(secs.filter(s => s.heading.startsWith("continuity"))).toHaveLength(2);
  expect(matching(secs, "continuity")).toHaveLength(4);
});

test("Action lines are found through every qualifier and bold variant", () => {
  const acts = findActions(matching(parseSections(DRIFTED), "continuity"));
  expect(acts).toHaveLength(4);
  expect(acts.map(a => a.qualifier))
    .toEqual(["", "(recurring, unmoved)", "(new)", "(10th repetition)"]);
  expect(acts[2].text).toBe("put the graphify binary on a PATH non-interactive shells see.");
});

test("a section with no Action contributes none", () => {
  const secs = parseSections(DRIFTED).filter(s => s.tool === "pastiche CLI");
  expect(secs).toHaveLength(1);
  expect(findActions(secs)).toHaveLength(0);
});

test("a loose match is loose on purpose — 'pastiche' also reaches a combined hook heading", () => {
  const hit = matching(parseSections(DRIFTED), "pastiche");
  expect(hit.map(s => s.tool))
    .toEqual(["hook: SessionStart (ponytail + continuity + pastiche)", "pastiche CLI"]);
});

// --- reports ---------------------------------------------------------------

test("reportActions leads with the count, the match rate and the drift", () => {
  const out = reportActions(parseSections(DRIFTED), "continuity", 20).split("\n");
  expect(out[0]).toBe('4 open of 4 · "continuity" matches 4/5 sections, 4 spellings');
  expect(out[1]).toContain("(10th repetition)"); // newest first
});

// --- the stale tail: a backlog you cannot see is one you cannot close -------
// Recency alone made the journal write-only — an action left the 20-row view in
// about four days and was never displayed again. These pin the arithmetic, both
// directions: nothing hidden that is not counted, nothing counted that is shown.

/** N actions, newest last on disk, so acts[] comes back newest-first. */
const manyActions = (n: number) =>
  parseSections(
    Array.from({ length: n }, (_, i) =>
      [
        `## 2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00-05:00  •  s  •  ${i}`,
        "",
        `### tool-${i}  •  1 run  •  verdict: helped`,
        `- Action: fix number ${i}.`,
        "",
      ].join("\n"),
    ).join("\n"),
  );

test("reportActions caps rows, shows the oldest anyway, and counts only the hidden middle", () => {
  const out = reportActions(manyActions(30), undefined, 20).split("\n");
  expect(out[0]).toBe("30 open of 30");
  expect(out.filter(l => l === "stale:")).toHaveLength(1);
  // 20 newest + 5 oldest shown, so exactly 5 sit unseen in the middle.
  expect(out).toContain("+5 older");
  expect(out.at(-1)).toContain("fix number 0.");   // the very oldest is on screen
  expect(out[1]).toContain("fix number 29.");      // ...and so is the newest
});

test("the stale block never repeats a row the recent head already showed", () => {
  const out = reportActions(manyActions(30), undefined, 20);
  const shown = out.split("\n").filter(l => /fix number \d+\./.test(l));
  expect(new Set(shown).size).toBe(shown.length);
  expect(shown).toHaveLength(25);
});

test("recent + stale + hidden always equals the total", () => {
  for (const [n, limit] of [[30, 20], [4, 2], [26, 20], [25, 20], [1, 20]] as const) {
    const out = reportActions(manyActions(n), undefined, limit).split("\n");
    const shown = out.filter(l => /fix number \d+\./.test(l)).length;
    const hiddenLine = out.find(l => /^\+\d+ older$/.test(l));
    const hidden = hiddenLine ? Number.parseInt(hiddenLine.slice(1), 10) : 0;
    expect(shown + hidden).toBe(n);
  }
});

// The other direction. A short backlog is fully visible, so a stale block would
// be duplicate rows under a heading that implies neglect — the "no lines that
// say nothing happened" rule.
test("no stale block, and no hidden count, when every action already fits", () => {
  const out = reportActions(manyActions(20), undefined, 20);
  expect(out).not.toContain("stale:");
  expect(out).not.toContain("older");
  expect(out.split("\n").filter(l => /fix number/.test(l))).toHaveLength(20);
});

test("a backlog just past the cap spills into stale rather than hiding anything", () => {
  const out = reportActions(manyActions(22), undefined, 20).split("\n");
  expect(out).toContain("stale:");
  expect(out.some(l => /^\+\d+ older$/.test(l))).toBe(false);
  expect(out.at(-1)).toContain("fix number 0.");
});

test("reportActions on no match states the zero rather than staying silent", () => {
  expect(reportActions(parseSections(DRIFTED), "nosuchtool", 20))
    .toBe('0 open of 0 · "nosuchtool" matches 0/5 sections, 0 spellings');
});

test("reportRecent returns whole sections, newest first", () => {
  const out = reportRecent(parseSections(DRIFTED), "continuity", 2);
  expect(out.split("\n")[0]).toBe('4 sections · "continuity" · 4 spellings · showing last 2');
  expect(out).toContain("### continuity:wrap (step-5 mtime rule)");
  expect(out).not.toContain("### continuity scan.ts");
});

// --- Closed: the retirement wrap/SKILL.md has always asked for and never had ---

const WITH_CLOSED = formatEntry({
  timestamp: "2026-09-08T21:00:00-05:00",
  slug: "enfurbish",
  session: "deadbeef",
  arc: "closed two standing actions",
  tools: [{
    name: "pastiche (SessionStart hook)",
    verdict: "neutral",
    notes: ["3 due, 1 surfaced"],
    closed: ["the register gate — retired; subject match, not register, is the predictor"],
    action: "something still open",
  }],
});

test("formatEntry renders Closed where parseSections and findClosed can see it", () => {
  const secs = parseSections(WITH_CLOSED);
  const done = findClosed(secs);
  expect(done).toHaveLength(1);
  expect(done[0].text).toContain("register gate");
  expect(done[0].tool).toBe("pastiche (SessionStart hook)");
});

// Closed and open must not contaminate each other: the whole point is that a
// reader can tell them apart.
test("findActions does not pick up Closed lines, and findClosed does not pick up Actions", () => {
  const secs = parseSections(WITH_CLOSED);
  expect(findActions(secs).map(a => a.text)).toEqual(["something still open"]);
  expect(findClosed(secs).map(a => a.text)).not.toContain("something still open");
});

test("reportActions leads with the closed block so a reader reaches it", () => {
  const out = reportActions(parseSections(WITH_CLOSED), undefined, 20);
  expect(out).toContain("1 open of 1 · 1 closed (1 names no #id)");
  expect(out.indexOf("closed:")).toBeLessThan(out.indexOf("open:"));
  expect(out.indexOf("register gate")).toBeLessThan(out.indexOf("something still open"));
});

// The other direction: no closed lines means no closed block and no count. A
// journal with 312 open actions and none retired must not grow boilerplate.
test("reportActions says nothing about closed when nothing is closed", () => {
  const plain = formatEntry({
    timestamp: "2026-09-08T21:00:00-05:00", slug: "x", session: "d", arc: "a",
    tools: [{ name: "t", verdict: "helped", action: "do the thing" }],
  });
  const out = reportActions(parseSections(plain), undefined, 20);
  expect(out).toContain("1 open of 1");
  expect(out).not.toContain("closed");
  expect(out).not.toContain("open:");
});
