import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContext, formatEntry, loadConfig, loadNotes, mark, parseLedger, restamp, stalest, today,
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

  test("lists the due items with their last-surfaced dates", () => {
    const out = buildContext({
      cfg, due: stalest(parseLedger(LEDGER), 2), notes: "", pluginRoot: "/plugins/pastiche",
    });
    expect(out).toContain("ផ្ទះ (phteah) — house");
    expect(out).toContain("[last surfaced 2026-01-05]");
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
    expect(out).not.toContain("seen: <today>");
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
