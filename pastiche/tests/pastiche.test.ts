import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContext, loadConfig, loadNotes, parseLedger, restamp, stalest, today,
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

describe("loadConfig", () => {
  test("defaults when there is no config file", () => {
    const cfg = loadConfig(freshDir());
    expect(cfg.due).toBe(5);
    expect(cfg.languages).toEqual([]);
    expect(cfg.ledger).toEndWith("ledger.md");
  });

  test("malformed JSON falls back instead of throwing", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), "{ not json");
    expect(loadConfig(dir).due).toBe(5);
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

  test("an empty ledger still produces usable guidance", () => {
    const out = buildContext({ cfg, due: [], notes: "", pluginRoot: "/p" });
    expect(out).toContain("ledger empty");
  });
});

describe("loadNotes", () => {
  test("reads the shipped language files for configured languages only", () => {
    const root = join(import.meta.dir, "..");
    const km = loadNotes(root, { ledger: "", due: 5, languages: [{ code: "km", name: "Khmer", domains: "" }] });
    expect(km).toContain("aspiration");
    expect(km).not.toContain("cognates");
  });

  test("an unknown language code is skipped, not fatal", () => {
    const root = join(import.meta.dir, "..");
    expect(loadNotes(root, { ledger: "", due: 5, languages: [{ code: "zz", name: "?", domains: "" }] }))
      .toBe("");
  });
});

test("today formats as YYYY-MM-DD", () => {
  expect(today(new Date("2026-08-12T22:00:00Z"))).toBe("2026-08-12");
});
