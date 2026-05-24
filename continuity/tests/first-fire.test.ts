import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markFirstFire } from "../lib/first-fire";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "continuity-firstfire-test-"));
}

describe("markFirstFire", () => {
  test("first call returns true and creates marker", () => {
    const dir = freshDir();
    const sid = "abc-123";
    expect(markFirstFire(dir, sid)).toBe(true);
    expect(existsSync(join(dir, sid))).toBe(true);
  });

  test("second call returns false (marker exists)", () => {
    const dir = freshDir();
    const sid = "abc-123";
    expect(markFirstFire(dir, sid)).toBe(true);
    expect(markFirstFire(dir, sid)).toBe(false);
  });

  test("distinct session ids are independent", () => {
    const dir = freshDir();
    expect(markFirstFire(dir, "alpha")).toBe(true);
    expect(markFirstFire(dir, "beta")).toBe(true);
    expect(markFirstFire(dir, "alpha")).toBe(false);
  });

  test("creates state dir if missing", () => {
    const parent = freshDir();
    const nested = join(parent, "nested", "child");
    expect(existsSync(nested)).toBe(false);
    expect(markFirstFire(nested, "sid")).toBe(true);
    expect(existsSync(join(nested, "sid"))).toBe(true);
  });

  test("prunes markers older than ttlDays", () => {
    const dir = freshDir();
    const oldSid = "stale-session";
    const freshSid = "fresh-session";
    // Create both markers.
    markFirstFire(dir, oldSid);
    markFirstFire(dir, freshSid);
    // Backdate oldSid's mtime by 10 days.
    const past = (Date.now() - 10 * 86400_000) / 1000;
    utimesSync(join(dir, oldSid), past, past);
    // New fire with a different sid prunes (default ttl 7 days).
    markFirstFire(dir, "trigger-prune");
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(["fresh-session", "trigger-prune"]);
  });

  test("ttlDays parameter is honored", () => {
    const dir = freshDir();
    markFirstFire(dir, "one-day-old");
    const past = (Date.now() - 86400_000 - 1000) / 1000; // just over 1 day
    utimesSync(join(dir, "one-day-old"), past, past);
    markFirstFire(dir, "trigger", 1);
    expect(existsSync(join(dir, "one-day-old"))).toBe(false);
  });

  test("session id with path separators is sanitized", () => {
    // Defensive: real session ids are uuids, but if a caller passes "../foo"
    // we should not escape the state dir.
    const dir = freshDir();
    expect(markFirstFire(dir, "../escape")).toBe(true);
    // ".." → "__", "/" → "_", "escape" passes through → "___escape"
    expect(existsSync(join(dir, "___escape"))).toBe(true);
  });
});
