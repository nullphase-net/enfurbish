import { test, expect } from "bun:test";
import {
  findActions, formatEntry, matching, parseSections, reportActions, reportRecent,
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
  expect(out[0]).toBe('4 actions · "continuity" matches 4/5 sections, 4 spellings');
  expect(out[1]).toContain("(10th repetition)"); // newest first
});

test("reportActions caps rows and says how many it hid", () => {
  const out = reportActions(parseSections(DRIFTED), undefined, 2).split("\n");
  expect(out[0]).toBe("4 actions");
  expect(out.at(-1)).toBe("+2 older");
});

test("reportActions on no match states the zero rather than staying silent", () => {
  expect(reportActions(parseSections(DRIFTED), "nosuchtool", 20))
    .toBe('0 actions · "nosuchtool" matches 0/5 sections, 0 spellings');
});

test("reportRecent returns whole sections, newest first", () => {
  const out = reportRecent(parseSections(DRIFTED), "continuity", 2);
  expect(out.split("\n")[0]).toBe('4 sections · "continuity" · 4 spellings · showing last 2');
  expect(out).toContain("### continuity:wrap (step-5 mtime rule)");
  expect(out).not.toContain("### continuity scan.ts");
});
