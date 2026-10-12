import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// symbion's skill tells its users that /wrap and /next (0.8.5 and later) honour a
// handoff whose open list lives in another tool. Nothing else in this repo knows
// that promise exists: a rewrite that drops either paragraph must update it there.
const DELEGATION = "If the file says its open list lives in another tool";

for (const skill of ["wrap", "next"]) {
  test(`${skill}/SKILL.md keeps the delegated-list paragraph`, () => {
    const text = readFileSync(join(import.meta.dir, "..", "skills", skill, "SKILL.md"), "utf8");
    expect(text).toContain(DELEGATION);
  });
}

// The same for the whole handoff: symbion's skill tells its users that /wrap -j
// writes the retro and the journal and no handoff file, and that /next briefs from
// a session-start hook's output when no file exists.
const HANDOFF_ELSEWHERE: [string, string][] = [
  ["wrap", "`/wrap -j` (or `--journal`) runs every step but 5"],
  ["next", "A session-start hook that already printed another tool's open list is the exception"],
];

for (const [skill, line] of HANDOFF_ELSEWHERE) {
  test(`${skill}/SKILL.md keeps the handoff-elsewhere line`, () => {
    const text = readFileSync(join(import.meta.dir, "..", "skills", skill, "SKILL.md"), "utf8");
    expect(text).toContain(line);
  });
}
