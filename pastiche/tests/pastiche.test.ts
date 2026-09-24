import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContext, DORMANT_AFTER, formatCorrection, formatEntry, loadConfig, loadNotes, mark,
  parseLedger, recordSurfaced, restamp, stalest, tag, today, type Entry, type Surfaced,
} from "../lib/pastiche";

const LEDGER = `# Ledger

Prose in the header is ignored — only lines starting with a code are entries.

- km: ទឹក (teuk) — water | 2026-01-01 | seen: 2026-03-01
- km: ផ្ទះ (phteah) — house | 2026-01-01 | ✓✓ family baseline | seen: 2026-01-05
- es: la red — network | 2026-02-01 | ✓ | seen: 2026-02-01
- es: el puerto — port | 2026-02-02
`;

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "pastiche-test-"));
}

describe("parseLedger", () => {
  test("pulls code, term, dates; ignores prose", () => {
    const e = parseLedger(LEDGER);
    expect(e.length).toBe(4);
    expect(e[0].code).toBe("km");
    expect(e[0].term).toBe("ទឹក (teuk) — water");
    expect(e[0].introduced).toBe("2026-01-01");
    expect(e[0].seen).toBe("2026-03-01");
  });

  test("marks field is optional and not mistaken for a date", () => {
    const e = parseLedger(LEDGER);
    expect(e[1].introduced).toBe("2026-01-01");
    expect(e[1].seen).toBe("2026-01-05");
  });

  test("a line with no seen: falls back to its introduce date", () => {
    const e = parseLedger(LEDGER);
    expect(e[3].term).toBe("el puerto — port");
    expect(e[3].seen).toBe("2026-02-02");
  });
});

describe("stalest", () => {
  test("oldest seen: first, and respects n", () => {
    const due = stalest(parseLedger(LEDGER), 2);
    expect(due.map(e => e.seen)).toEqual(["2026-01-05", "2026-02-01"]);
  });

  test("ties keep ledger order", () => {
    const tied = parseLedger(
      "- es: uno — one | 2026-01-01 | seen: 2026-01-01\n" +
      "- es: dos — two | 2026-01-01 | seen: 2026-01-01\n",
    );
    expect(stalest(tied, 2).map(e => e.term)).toEqual(["uno — one", "dos — two"]);
  });

  test("n larger than the ledger is not an error", () => {
    expect(stalest(parseLedger(LEDGER), 99).length).toBe(4);
  });
});

// The hook told every session a skipped due item "rotates back", and nothing
// rotated it: ប៉ា headed the due list from 2026-09-02 to 2026-09-24 (symbion 7c2).
describe("dormancy", () => {
  const FAMILY =
    "- km: ប៉ា (pa) — dad | 2026-01-01 | seen: 2026-01-01\n" +
    "- km: ម៉ាក់ (mak) — mom | 2026-01-01 | seen: 2026-02-01\n";
  const DAD = "ប៉ា (pa) — dad";
  const MOM = "ម៉ាក់ (mak) — mom";

  // Each id is one session start that showed the head of the list and did not use it.
  function show(entries: Entry[], ids: string[], date = "2026-03-01", s: Surfaced = {}): Surfaced {
    return ids.reduce((acc, id) => recordSurfaced(acc, stalest(entries, 1, acc), id, date), s);
  }

  test(`an item shown in ${DORMANT_AFTER} sessions without use rotates behind fresher ones`, () => {
    const e = parseLedger(FAMILY);
    const ids = Array.from({ length: DORMANT_AFTER }, (_, i) => `s${i}`);
    expect(stalest(e, 1, show(e, ids.slice(0, -1)))[0].term).toBe(DAD);
    expect(stalest(e, 1, show(e, ids))[0].term).toBe(MOM);
  });

  test("a re-fire in the same session (compaction, resume) counts once", () => {
    const e = parseLedger(FAMILY);
    // Exactly DORMANT_AFTER: any more and a miscount rotates mom out too, and
    // the ledger-order tie-break puts dad back on top.
    const s = show(e, Array(DORMANT_AFTER).fill("same"));
    expect(stalest(e, 1, s)[0].term).toBe(DAD);
  });

  test("using it starts the count over", () => {
    const e = parseLedger(FAMILY);
    const almost = Array.from({ length: DORMANT_AFTER - 1 }, (_, i) => `a${i}`);
    const s = show(e, almost);
    // Used in the last of those sessions, but still staler than mom.
    const used = parseLedger(restamp(FAMILY, "(pa)", "2026-01-15"));
    const again = show(used, almost.map(id => `b${id}`), "2026-03-01", s);
    expect(stalest(used, 1, again)[0].term).toBe(DAD);
  });

  test("a rotated item comes back once the rest have rotated past it, and counts afresh", () => {
    const e = parseLedger(FAMILY);
    const ids = (p: string) => Array.from({ length: DORMANT_AFTER }, (_, i) => `${p}${i}`);
    let s = show(e, ids("dad"), "2026-03-01");
    expect(stalest(e, 1, s)[0].term).toBe(MOM);
    s = show(e, ids("mom"), "2026-03-02", s);
    expect(stalest(e, 1, s)[0].term).toBe(DAD);
    // One session at a time, for the same tie-break reason: a count carried
    // over from before the rotation sends dad back on the first showing.
    for (const id of ids("again").slice(0, -1)) {
      s = show(e, [id], "2026-03-03", s);
      expect(stalest(e, 1, s)[0].term).toBe(DAD);
    }
  });
});

describe("restamp", () => {
  test("rewrites only the matching line and preserves marks", () => {
    const out = restamp(LEDGER, "teuk", "2026-08-12");
    expect(out).toContain("ទឹក (teuk) — water | 2026-01-01 | seen: 2026-08-12");
    expect(out).toContain("✓✓ family baseline | seen: 2026-01-05");
  });

  test("no match leaves the text byte-identical", () => {
    expect(restamp(LEDGER, "nothing-here", "2026-08-12")).toBe(LEDGER);
  });

  test("a header line containing the needle is not rewritten", () => {
    const withHeader = `mentions teuk in prose\n${LEDGER}`;
    expect(restamp(withHeader, "teuk", "2026-08-12").split("\n")[0])
      .toBe("mentions teuk in prose");
  });

  test("is idempotent", () => {
    const once = restamp(LEDGER, "teuk", "2026-08-12");
    expect(restamp(once, "teuk", "2026-08-12")).toBe(once);
  });
});

describe("mark", () => {
  test("prepends ✓ to an existing marks field and restamps", () => {
    const out = mark(LEDGER, "phteah", "2026-08-12");
    expect(out).toContain("| ✓✓✓ family baseline | seen: 2026-08-12");
  });

  test("inserts a marks field when the line has none", () => {
    const out = mark(LEDGER, "teuk", "2026-08-12");
    expect(out).toContain("ទឹក (teuk) — water | 2026-01-01 | ✓ | seen: 2026-08-12");
  });

  test("adds both marks and seen: to a line that has neither", () => {
    const out = mark(LEDGER, "el puerto", "2026-08-12");
    expect(out).toContain("el puerto — port | 2026-02-02 | ✓ | seen: 2026-08-12");
  });

  test("leaves other lines and prose alone", () => {
    const out = mark(`mentions teuk in prose\n${LEDGER}`, "teuk", "2026-08-12");
    expect(out.split("\n")[0]).toBe("mentions teuk in prose");
    expect(out).toContain("la red — network | 2026-02-01 | ✓ | seen: 2026-02-01");
  });

  test("no match leaves the text byte-identical", () => {
    expect(mark(LEDGER, "nothing-here", "2026-08-12")).toBe(LEDGER);
  });

  test("marks accumulate — it is not idempotent, by design", () => {
    const twice = mark(mark(LEDGER, "teuk", "2026-08-12"), "teuk", "2026-08-13");
    expect(twice).toContain("| ✓✓ | seen: 2026-08-13");
  });
});

describe("formatEntry", () => {
  test("stamps today into both date fields", () => {
    expect(formatEntry("km", "ទឹក (teuk) — water", "2026-08-12"))
      .toBe("- km: ទឹក (teuk) — water | 2026-08-12 | seen: 2026-08-12");
  });

  test("round-trips through the parser", () => {
    const e = parseLedger(formatEntry("es", "la red — network", "2026-08-12"));
    expect(e.length).toBe(1);
    expect(e[0].code).toBe("es");
    expect(e[0].term).toBe("la red — network");
    expect(e[0].seen).toBe("2026-08-12");
  });
});

describe("loadConfig", () => {
  test("defaults when there is no config file", () => {
    const cfg = loadConfig(freshDir());
    expect(cfg.due).toBe(5);
    expect(cfg.fresh).toBe(2);
    expect(cfg.languages).toEqual([]);
    expect(cfg.ledger).toEndWith("ledger.md");
  });

  test("malformed JSON falls back instead of throwing", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), "{ not json");
    expect(loadConfig(dir).due).toBe(5);
    expect(loadConfig(dir).fresh).toBe(2);
  });

  test("fresh can be set to 0 to turn off new vocabulary", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ fresh: 0 }));
    expect(loadConfig(dir).fresh).toBe(0);
  });

  test("expands ~ in the ledger path", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ledger: "~/vocab.md" }));
    const cfg = loadConfig(dir);
    expect(cfg.ledger).not.toStartWith("~");
    expect(cfg.ledger).toEndWith("/vocab.md");
  });
});

describe("buildContext", () => {
  const cfg = {
    ledger: "/tmp/ledger.md",
    due: 2,
    fresh: 2,
    languages: [{ code: "km", name: "Khmer", domains: "everyday, family" }],
  };

  test("lists the due items with their last-used dates", () => {
    const out = buildContext({
      cfg, due: stalest(parseLedger(LEDGER), 2), notes: "", pluginRoot: "/plugins/pastiche",
    });
    expect(out).toContain("ផ្ទះ (phteah) — house");
    expect(out).toContain("[last used 2026-01-05]");
    expect(out).toContain("Khmer (km) — everyday, family");
    expect(out).toContain("/plugins/pastiche/lib/pastiche.ts");
  });

  test("an empty ledger asks for a first batch instead of going quiet", () => {
    const out = buildContext({ cfg, due: [], notes: "", pluginRoot: "/p" });
    expect(out).toContain("nothing due yet");
    expect(out).toContain("/tmp/ledger.md");
  });

  test("states the new-term budget, and drops the section when fresh is 0", () => {
    const on = buildContext({ cfg, due: [], notes: "", pluginRoot: "/p" });
    expect(on).toContain("Introduce up to 2 new term");

    const off = buildContext({ cfg: { ...cfg, fresh: 0 }, due: [], notes: "", pluginRoot: "/p" });
    expect(off).not.toContain("Introduce up to");
  });

  // The recap kept coming out km+es because "bilingual" reads as "the two
  // languages I'm learning". The prompt has to name English explicitly.
  test("pins the recap to target-language + English", () => {
    const out = buildContext({ cfg, due: [], notes: "", pluginRoot: "/p" });
    expect(out).toContain("English");
    expect(out).not.toContain("bilingual");
  });

  // Writing the ledger is deterministic, so the prompt names commands rather
  // than handing the model a format string to assemble by hand.
  test("names the CLI commands instead of handing over a line format", () => {
    const out = buildContext({ cfg, due: [], notes: "", pluginRoot: "/p" });
    expect(out).toContain("--add");
    expect(out).toContain("--mark");
    expect(out).toContain("--correct");
    expect(out).not.toContain("seen: <today>");
    // The correction shape is the CLI's to render; the prompt must not spell it out.
    expect(out).not.toContain("<wrong> → <right>");
  });

  // Eight wraps logged a "register gate" for due items that never surfaced. Three
  // consecutive sessions then falsified the framing: the failing items were
  // technical vocabulary in entirely technical sessions, which register cannot
  // explain. Subject match is the predictor, and the new-term budget already used it.
  test("lets an unfitting due item stay due instead of forcing it, on subject not register", () => {
    const out = buildContext({
      cfg, due: stalest(parseLedger(LEDGER), 2), notes: "", pluginRoot: "/p",
    });
    expect(out).toContain("scheduling mismatch");
    expect(out).toContain("subject");
    expect(out).not.toContain("register");
  });

  // 7c2: "it rotates back" was a promise no code kept. The text now states the
  // rule the hook enforces, with the number the hook uses.
  test("says when a skipped due item leaves the list, with the count the code uses", () => {
    const out = buildContext({
      cfg, due: stalest(parseLedger(LEDGER), 2), notes: "", pluginRoot: "/p",
    });
    expect(out).toContain(`${DORMANT_AFTER} sessions`);
    expect(out).not.toContain("it rotates back.");
  });

  // recordar (to remember) went out as "ya está recordado" for "recorded". The
  // session had an opening for "remember" and took the due term by its shape
  // instead: a meaning failure the scheduling-mismatch rule cannot catch.
  test("binds a due term to its gloss, so a look-alike English word is a false friend, not an opening", () => {
    const out = buildContext({
      cfg, due: stalest(parseLedger(LEDGER), 2), notes: "", pluginRoot: "/p",
    });
    expect(out).toContain("gloss");
    expect(out).toContain("false friend");
  });

  test("does not suppress new vocabulary in favor of the due list", () => {
    const out = buildContext({
      cfg, due: stalest(parseLedger(LEDGER), 2), notes: "", pluginRoot: "/p",
    });
    expect(out).not.toContain("before introducing new vocab");
    expect(out).not.toContain("rather than piling on new ones");
  });
});

describe("loadNotes", () => {
  test("reads the shipped language files for configured languages only", () => {
    const root = join(import.meta.dir, "..");
    const km = loadNotes(root, { ledger: "", due: 5, fresh: 2, languages: [{ code: "km", name: "Khmer", domains: "" }] });
    expect(km).toContain("aspiration");
    expect(km).not.toContain("cognates");
  });

  test("an unknown language code is skipped, not fatal", () => {
    const root = join(import.meta.dir, "..");
    expect(loadNotes(root, { ledger: "", due: 5, fresh: 2, languages: [{ code: "zz", name: "?", domains: "" }] }))
      .toBe("");
  });
});

test("today formats as YYYY-MM-DD", () => {
  expect(today(new Date("2026-08-12T22:00:00Z"))).toBe("2026-08-12");
});

describe("formatEntry marks", () => {
  test("renders the optional third field", () => {
    expect(formatEntry("es", "costa → cuesta — o→ue when stressed", "2026-08-18", "✗"))
      .toBe("- es: costa → cuesta — o→ue when stressed | 2026-08-18 | ✗ | seen: 2026-08-18");
  });

  test("omitting it leaves the two-field shape untouched", () => {
    expect(formatEntry("es", "la red — network", "2026-08-18"))
      .toBe("- es: la red — network | 2026-08-18 | seen: 2026-08-18");
  });

  test("a marked line round-trips: the mark is not read as part of the term", () => {
    const e = parseLedger(formatEntry("es", "costa → cuesta — o→ue", "2026-08-18", "✗"));
    expect(e.length).toBe(1);
    expect(e[0].term).toBe("costa → cuesta — o→ue");
    expect(e[0].introduced).toBe("2026-08-18");
    expect(e[0].seen).toBe("2026-08-18");
  });
});

describe("formatCorrection", () => {
  test("keeps the wrong form — it is what predicts the next mistake", () => {
    expect(formatCorrection("costa", "cuesta", "costar is o→ue, stressed forms only"))
      .toBe("costa → cuesta — costar is o→ue, stressed forms only");
  });
});

// --- subject tags ----------------------------------------------------------
// The tag is evidence for the one test the prompt asks the model to run. It has
// to survive every other writer, and the marks field is the one it can collide
// with, so the mark x subj matrix is enumerated rather than sampled.

describe("subject tags", () => {
  test("parseLedger reads subj:, and an untagged line reads empty not undefined", () => {
    const e = parseLedger(
      "- es: la tierra — ground | 2026-02-01 | subj: rf, hardware | seen: 2026-02-01\n" +
      "- es: la red — network | 2026-02-01 | seen: 2026-02-01\n",
    );
    expect(e[0].subject).toBe("rf, hardware");
    expect(e[1].subject).toBe("");
  });

  test("formatEntry places subj after marks, and omits it when absent", () => {
    expect(formatEntry("es", "la tierra — ground", "2026-02-01", "✗", "rf")).toBe(
      "- es: la tierra — ground | 2026-02-01 | ✗ | subj: rf | seen: 2026-02-01",
    );
    expect(formatEntry("es", "la red — network", "2026-02-01")).toBe(
      "- es: la red — network | 2026-02-01 | seen: 2026-02-01",
    );
    expect(formatEntry("es", "la red — network", "2026-02-01", undefined, "net")).toBe(
      "- es: la red — network | 2026-02-01 | subj: net | seen: 2026-02-01",
    );
  });

  test("mark never lands its ✓ on the subj field — all four shapes", () => {
    const at = (l: string) => parseLedger(mark(l, "x —", "2026-05-05"))[0];
    // no marks, no subj
    expect(at("- es: x — y | 2026-01-01 | seen: 2026-01-01").line)
      .toBe("- es: x — y | 2026-01-01 | ✓ | seen: 2026-05-05");
    // marks, no subj
    expect(at("- es: x — y | 2026-01-01 | ✓ | seen: 2026-01-01").line)
      .toBe("- es: x — y | 2026-01-01 | ✓✓ | seen: 2026-05-05");
    // subj, no marks — the ✓ must be inserted before it, not onto it
    const c = at("- es: x — y | 2026-01-01 | subj: rf | seen: 2026-01-01");
    expect(c.line).toBe("- es: x — y | 2026-01-01 | ✓ | subj: rf | seen: 2026-05-05");
    expect(c.subject).toBe("rf");
    // marks and subj
    const d = at("- es: x — y | 2026-01-01 | ✗ | subj: rf | seen: 2026-01-01");
    expect(d.line).toBe("- es: x — y | 2026-01-01 | ✓✗ | subj: rf | seen: 2026-05-05");
    expect(d.subject).toBe("rf");
  });

  test("restamp leaves the tag alone", () => {
    const l = "- es: x — y | 2026-01-01 | subj: rf | seen: 2026-01-01";
    expect(parseLedger(restamp(l, "x —", "2026-05-05"))[0].subject).toBe("rf");
  });

  test("tag sets, replaces, and leaves non-matching lines untouched", () => {
    const text =
      "- es: la tierra — ground | 2026-02-01 | seen: 2026-02-01\n" +
      "- es: la red — network | 2026-02-01 | seen: 2026-02-01\n";
    const once = tag(text, "la tierra", "rf, hardware");
    expect(parseLedger(once)[0].subject).toBe("rf, hardware");
    expect(parseLedger(once)[1].subject).toBe("");
    expect(parseLedger(tag(once, "la tierra", "electrical"))[0].subject).toBe("electrical");
  });

  test("tag appends to a line that has no seen: field at all", () => {
    const e = parseLedger(tag("- es: el puerto — port | 2026-02-02", "el puerto", "net"))[0];
    expect(e.subject).toBe("net");
    expect(e.seen).toBe("2026-02-02");
  });

  test("buildContext brackets a tagged due item and brackets nothing for an untagged one", () => {
    const cfg = { ledger: "/tmp/l.md", languages: [{ code: "es", name: "Spanish", domains: "tech" }], due: 5, fresh: 2 };
    const due = parseLedger(
      "- es: la tierra — ground | 2026-02-01 | subj: rf, hardware | seen: 2026-02-01\n" +
      "- es: la red — network | 2026-02-01 | seen: 2026-02-02\n",
    );
    const ctx = buildContext({ cfg, due, notes: "", pluginRoot: "/p" });
    expect(ctx).toContain("- es: la tierra — ground  [rf, hardware]  [last used 2026-02-01]");
    expect(ctx).toContain("- es: la red — network  [last used 2026-02-02]");
    expect(ctx).not.toContain("la red — network  []");
  });
});

// --- local date ------------------------------------------------------------

// `bun test` runs with the process timezone forced to UTC — getTimezoneOffset()
// is 0 inside a test and 300 under `bun run` on this machine. An in-process
// assertion therefore cannot tell a local implementation from a UTC one, and
// would pass against either forever. These run in a child with a real zone.

function todayUnder(tz: string, y: number, m: number, d: number, h: number): string {
  const lib = join(import.meta.dir, "..", "lib", "pastiche.ts");
  const r = spawnSync(
    "bun",
    ["-e", `import { today } from ${JSON.stringify(lib)};` +
           `process.stdout.write(today(new Date(${y}, ${m}, ${d}, ${h}, 30)));`],
    { encoding: "utf8", env: { ...process.env, TZ: tz } },
  );
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return r.stdout.trim();
}

test("today() uses the local calendar date west of UTC", () => {
  // Local 2026-09-18 23:30 in Chicago is 2026-09-19T04:30Z — toISOString() would
  // stamp tomorrow, which is the measured bug.
  expect(todayUnder("America/Chicago", 2026, 8, 18, 23)).toBe("2026-09-18");
});

test("today() uses the local calendar date east of UTC", () => {
  // Local 2026-09-18 00:30 in Berlin is 2026-09-17T22:30Z — the same bug in the
  // other direction, which a single westward case would not catch.
  expect(todayUnder("Europe/Berlin", 2026, 8, 18, 0)).toBe("2026-09-18");
});
