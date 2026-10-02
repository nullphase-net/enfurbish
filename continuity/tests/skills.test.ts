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
