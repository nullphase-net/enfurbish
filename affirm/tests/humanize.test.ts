import { describe, expect, test } from "bun:test";
import { humanizeDelta } from "../lib/humanize";

describe("humanizeDelta", () => {
  test("zero returns 0s", () => {
    expect(humanizeDelta(0)).toBe("0s");
  });

  test("negative returns 0s (clamped, callers' clock skew)", () => {
    expect(humanizeDelta(-5_000)).toBe("0s");
  });

  test("sub-second returns <1s", () => {
    expect(humanizeDelta(500)).toBe("<1s");
  });

  test("seconds only", () => {
    expect(humanizeDelta(45 * 1000)).toBe("45s");
  });

  test("minutes + seconds (two units)", () => {
    expect(humanizeDelta(5 * 60_000 + 12_000)).toBe("5m 12s");
  });

  test("minutes only when seconds == 0", () => {
    expect(humanizeDelta(7 * 60_000)).toBe("7m");
  });

  test("hours + minutes", () => {
    expect(humanizeDelta(3 * 3600_000 + 25 * 60_000)).toBe("3h 25m");
  });

  test("days + hours", () => {
    expect(humanizeDelta(3 * 86400_000 + 4 * 3600_000)).toBe("3d 4h");
  });

  test("days only when hours == 0", () => {
    expect(humanizeDelta(2 * 86400_000)).toBe("2d");
  });

  test("largest two units, drops sub-units", () => {
    // 1d 2h 30m 45s — should show only "1d 2h"
    expect(humanizeDelta(86400_000 + 2 * 3600_000 + 30 * 60_000 + 45_000)).toBe("1d 2h");
  });

  test("very large (weeks rendered as days)", () => {
    // 14d 0h
    expect(humanizeDelta(14 * 86400_000)).toBe("14d");
  });
});
