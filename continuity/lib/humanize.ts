/**
 * Format a duration in milliseconds as a compact human-readable delta.
 * Returns the largest two non-zero units (e.g., "3d 4h", "5m 12s").
 * Drops units finer than the second-largest unit (e.g., "1d 2h 30m" → "1d 2h").
 * Edge cases: 0 → "0s", negative → "0s" (clock skew), <1s but >0 → "<1s".
 */
export function humanizeDelta(deltaMs: number): string {
  if (deltaMs <= 0) return "0s";
  if (deltaMs < 1_000) return "<1s";

  const totalSecs = Math.floor(deltaMs / 1_000);
  const d = Math.floor(totalSecs / 86_400);
  const h = Math.floor((totalSecs % 86_400) / 3_600);
  const m = Math.floor((totalSecs % 3_600) / 60);
  const s = totalSecs % 60;

  // Pick the largest non-zero unit, then optionally append the next unit if non-zero.
  const units: Array<[number, string]> = [
    [d, "d"], [h, "h"], [m, "m"], [s, "s"],
  ];
  for (let i = 0; i < units.length; i++) {
    if (units[i][0] === 0) continue;
    const [n1, u1] = units[i];
    const next = units[i + 1];
    if (next && next[0] > 0) return `${n1}${u1} ${next[0]}${next[1]}`;
    return `${n1}${u1}`;
  }
  // Unreachable: totalSecs >= 1 means at least one unit is non-zero.
  return "0s";
}
