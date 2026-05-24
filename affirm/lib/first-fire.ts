import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Sanitize a session id for use as a marker filename. Real session ids are
 * uuids (e.g., "3d1abca8-fe6d-4511-bb85-f454acf4e3e3"), but defensive: replace
 * any character outside `[A-Za-z0-9-]` with `_` so a malformed caller can't
 * escape the state dir via `..` or path separators.
 */
function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9-]/g, "_");
}

/**
 * Mark a SessionStart fire for this session_id and report whether it's the
 * first one. Side effect: prunes markers older than `ttlDays` (default 7) on
 * each call so the state dir doesn't grow unbounded.
 *
 * Returns `true` if this is the first fire for the session (the caller should
 * emit its banner), `false` if a prior marker exists (caller should suppress).
 */
export function markFirstFire(stateDir: string, sessionId: string, ttlDays = 7): boolean {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  const cutoff = Date.now() - ttlDays * 86_400_000;
  for (const name of readdirSync(stateDir)) {
    const full = join(stateDir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch { /* concurrent prune from another hook process — fine */ }
  }

  const marker = join(stateDir, safeName(sessionId));
  if (existsSync(marker)) return false;
  // Write an empty file; existence is the signal, mtime is the timestamp.
  writeFileSync(marker, "");
  return true;
}
