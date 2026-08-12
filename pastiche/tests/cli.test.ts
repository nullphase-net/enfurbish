import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, today, type Config } from "../lib/pastiche";

const NOW = today();

function fixture(seed?: string): Config {
  const dir = mkdtempSync(join(tmpdir(), "pastiche-cli-test-"));
  const ledger = join(dir, "nested", "ledger.md");
  if (seed !== undefined) {
    writeFileSync(join(dir, "ledger.md"), seed);
    return cfg(join(dir, "ledger.md"));
  }
  return cfg(ledger);
}

function cfg(ledger: string): Config {
  return {
    ledger,
    due: 2,
    fresh: 2,
    languages: [
      { code: "km", name: "Khmer", domains: "everyday" },
      { code: "es", name: "Spanish", domains: "technical" },
    ],
  };
}

const SEED =
  "- km: ទឹក (teuk) — water | 2026-01-01 | seen: 2026-01-01\n" +
  "- es: la red — network | 2026-02-01 | ✓ | seen: 2026-02-01\n";

describe("--add", () => {
  test("creates the ledger and its parent directory when missing", () => {
    const c = fixture();
    expect(existsSync(c.ledger)).toBe(false);
    expect(main(["--add", "km", "ផ្ទះ (phteah) — house"], c)).toBe(0);
    expect(readFileSync(c.ledger, "utf8"))
      .toBe(`- km: ផ្ទះ (phteah) — house | ${NOW} | seen: ${NOW}\n`);
  });

  test("appends without disturbing existing lines", () => {
    const c = fixture(SEED);
    main(["--add", "es", "el puerto — port"], c);
    const text = readFileSync(c.ledger, "utf8");
    expect(text).toStartWith(SEED);
    expect(text).toEndWith(`- es: el puerto — port | ${NOW} | seen: ${NOW}\n`);
  });

  test("repairs a missing trailing newline instead of joining two entries", () => {
    const c = fixture(SEED.trimEnd());
    main(["--add", "es", "el puerto — port"], c);
    expect(readFileSync(c.ledger, "utf8").split("\n").filter(Boolean).length).toBe(3);
  });

  test("refuses a language code that is not configured", () => {
    const c = fixture(SEED);
    expect(main(["--add", "fr", "bonjour — hello"], c)).toBe(0);
    expect(readFileSync(c.ledger, "utf8")).toBe(SEED);
  });

  test("does not create a duplicate", () => {
    const c = fixture(SEED);
    main(["--add", "es", "la red — network"], c);
    expect(readFileSync(c.ledger, "utf8")).toBe(SEED);
  });

  test("a missing argument is arg misuse, not a no-op", () => {
    expect(main(["--add", "km"], fixture(SEED))).toBe(2);
  });
});

describe("--seen / --mark", () => {
  test("--seen restamps in place", () => {
    const c = fixture(SEED);
    expect(main(["--seen", "teuk"], c)).toBe(0);
    expect(readFileSync(c.ledger, "utf8")).toContain(`(teuk) — water | 2026-01-01 | seen: ${NOW}`);
  });

  test("--mark adds a ✓ and restamps", () => {
    const c = fixture(SEED);
    expect(main(["--mark", "la red"], c)).toBe(0);
    expect(readFileSync(c.ledger, "utf8")).toContain(`| ✓✓ | seen: ${NOW}`);
  });

  // The repo convention: not-found is reported in text, exit 0. Only the
  // caller misusing the flag is an exit-2 error.
  test("no match leaves the file alone and still exits 0", () => {
    const c = fixture(SEED);
    expect(main(["--seen", "nothing-here"], c)).toBe(0);
    expect(readFileSync(c.ledger, "utf8")).toBe(SEED);
  });

  test("a missing ledger exits 0 rather than failing the session", () => {
    expect(main(["--seen", "teuk"], fixture())).toBe(0);
  });

  test("a missing term is arg misuse", () => {
    expect(main(["--mark"], fixture(SEED))).toBe(2);
  });
});

describe("default and --path", () => {
  test("--path prints the resolved ledger", () => {
    expect(main(["--path"], fixture(SEED))).toBe(0);
  });

  test("bare invocation on a missing ledger exits 0", () => {
    expect(main([], fixture())).toBe(0);
  });

  test("an unknown flag is arg misuse", () => {
    expect(main(["--bogus"], fixture(SEED))).toBe(2);
  });

  test("--due with a non-numeric count is arg misuse", () => {
    expect(main(["--due", "lots"], fixture(SEED))).toBe(2);
  });
});
