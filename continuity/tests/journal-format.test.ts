import { test, expect } from "bun:test";
import {
  findActions, findClosed, formatEntry, matching, noneActions, parseSections, reportActions, reportRecent,
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
  expect(findActions(secs)).toHaveLength(0);
});

test("what formatEntry writes, parseSections reads back", () => {
  const e = { ...ENTRY, tools: [{ ...ENTRY.tools[0], action: "count slash commands once." }] };
  const secs = parseSections(formatEntry(e));
  expect(secs[0].entry).toBe("2026-08-18T21:00:00-05:00");
  expect(secs[0].slug).toBe("enfurbish");
  expect(findActions(secs)[0].text).toBe("count slash commands once.");
});

// An action whose text is "none" was 18 open rows on 2026-09-26, each one a wrap
// saying there was nothing to do. The text is kept, as a note, because some carry
// a real observation after the "none" (#b6480a: "none. The check rule is doing
// disproportionate work; consider..."), so dropping it would lose that.
test("an action that says none is written as a note, and no reader finds an action", () => {
  const out = formatEntry(ENTRY);
  expect(out).toContain("- none — closed after six loggings.");
  expect(out).not.toContain("Action: none");
  expect(findActions(parseSections(out))).toHaveLength(0);
});

test("noneActions names the tools whose action said none, and only those", () => {
  expect(noneActions(ENTRY)).toEqual(["continuity scan.ts"]);
  expect(noneActions({ ...ENTRY, tools: [{ name: "t", verdict: "helped", action: "nonetheless, split it" }] }))
    .toEqual([]);
});

// --- the drift the readers exist to survive --------------------------------
// Every heading and Action spelling below is copied from the real journal.

const DRIFTED = [
  "## 2026-08-14T00:18:00-05:00  •  myapp  •  0a4ddd46",
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

// Wrap step 2 passes names from `skills_invoked`, `continuity:wrap`, and headings
// spell that tool `continuity (wrap, scan.ts)` as often as not. Measured 2026-09-29:
// `continuity:wrap` reached 77 of the 233 continuity sections. Every part of the
// name must appear, so an unrelated heading holding one part stays out.
test("a plugin:skill name reaches headings that spell it 'plugin (skill, …)', and only those", () => {
  const secs = parseSections([
    "## 2026-09-28T10:00:00Z  •  p  •  s",
    "", "### continuity:wrap (skill + scan.ts)  •  verdict: helped", "- a",
    "", "### continuity (wrap, scan.ts, handoffs.ts)  •  verdict: helped", "- b",
    "", "### continuity (next, handoffs.ts)  •  verdict: helped", "- c",
    "", "### wrap-up notes  •  verdict: neutral", "- d",
  ].join("\n"));
  expect(matching(secs, "continuity:wrap").map(s => s.body[0])).toEqual(["- a", "- b"]);
});

test("Action lines are found through every qualifier and bold variant", () => {
  const acts = findActions(matching(parseSections(DRIFTED), "continuity"));
  expect(acts).toHaveLength(4);
  expect(acts.map(a => a.qualifier))
    .toEqual(["", "(recurring, unmoved)", "(new)", "(10th repetition)"]);
  expect(acts[2].text).toBe("put the graphify binary on a PATH non-interactive shells see.");
});

// 53 bullets in the real journal carry their action after a sentence, inside the
// bullet ("…at 0 calls. Action (third repeat): scope it out."): the raw-markdown
// era, before formatEntry owned the shape. The start-of-bullet pattern never saw
// them, so they could be neither read nor retired.
const MIDLINE = [
  "## 2026-08-17T00:00:00Z  •  ocellus  •  aaaa1111",
  "",
  "### shodh-memory (MCP)  •  verdict: neutral",
  "- Fourth consecutive session at 0 calls. Action (third repeat, escalating): scope it out.",
  "- Stale banner persisted. **Action (recurring, unmoved across 8+ wraps):** run install.",
  "- The Action: heading in the skill is prose, not a sentence start.",
  "- Closed: #abcdef -- done. Action: text inside a close is not an action.",
  "- Action: a start-of-bullet action reads exactly as before.",
].join("\n");

test("an Action that starts a sentence mid-bullet is an action; prose and closes are not", () => {
  const acts = findActions(parseSections(MIDLINE));
  expect(acts.map(a => [a.qualifier, a.text])).toEqual([
    ["(third repeat, escalating)", "scope it out."],
    ["(recurring, unmoved across 8+ wraps)", "run install."],
    ["", "a start-of-bullet action reads exactly as before."],
  ]);
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

// --- the project a row came from --------------------------------------------
// The backlog is global, but a project-local tool's action can only be acted on in
// that project: 21 of 212 reviewed on 2026-09-26 were for tools like
// exotic-geometry-framework's tools/metric_diagnostic.py. The row says where it came
// from. Both header shapes are on disk: `  •  ` since formatEntry, `  -  ` before.

const TWO_SHAPES = [
  "## 2026-05-10T20:30:00-04:00  -  old-proj  -  0dfb260f",
  "",
  "### graphify  -  3 calls  -  verdict: helped",
  "- Action: old-shape header.",
  "",
  "## 2026-09-24T10:00:00Z  •  example.net  •  bbbb2222",
  "",
  "### loop (skill)  •  verdict: helped",
  "- Action: new-shape header.",
].join("\n");

test("every row names the project its entry came from, under both header shapes", () => {
  const secs = parseSections(TWO_SHAPES);
  expect(secs.map(s => s.slug)).toEqual(["old-proj", "example.net"]);
  const out = reportActions(secs, undefined, 20);
  expect(out).toMatch(/#[0-9a-f]{6}  \[old-proj\] .*old-shape header/);
  expect(out).toMatch(/#[0-9a-f]{6}  \[example\.net\] .*new-shape header/);
});

test("the slug does not move an old-shape entry's id: entry keeps its raw text", () => {
  // actionId hashes the entry string. Re-parsing the old `  -  ` header would have
  // renumbered every action written before formatEntry, and orphaned their closes.
  expect(parseSections(TWO_SHAPES)[0].entry).toBe("2026-05-10T20:30:00-04:00  -  old-proj  -  0dfb260f");
});

// --- full text ---------------------------------------------------------------

test("rows clip action text at 100 chars by default and print it whole with full", () => {
  const long = "x".repeat(150) + " END";
  const secs = parseSections(formatEntry({
    timestamp: "2026-09-26T10:00:00Z", slug: "p", session: "s", arc: "a",
    tools: [{ name: "t", verdict: "helped", action: long }],
  }));
  expect(reportActions(secs, undefined, 20)).not.toContain("END");
  expect(reportActions(secs, undefined, 20, true)).toContain(long);
});
