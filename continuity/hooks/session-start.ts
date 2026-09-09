#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import {
  collect,
  findProjectRoot,
  scanForNextSessions,
  scanForNextSessionsWithStats,
  type Handoff,
  type NextSessionFile,
  type ScanResult,
} from "../lib/handoffs";
import { humanizeDelta } from "../lib/humanize";
import { markFirstFire } from "../lib/first-fire";

// The scan itself lives in lib/handoffs.ts so `/next` can call it too; re-exported
// here because the hook was its original home and tests still address it there.
export {
  findProjectRoot,
  scanForNextSessions,
  scanForNextSessionsWithStats,
  type NextSessionFile,
  type ScanResult,
};

function fmtAge(mtimeMs: number, now: number): string {
  return `${humanizeDelta(now - mtimeMs)} ago`;
}

/**
 * ` · N commits behind` — the repo moved after the handoff was written.
 *
 * Age measures the file and the banner already said it; this measures the code the
 * file describes, and the two come apart exactly when the handoff is most misleading.
 * A pointer reported as a clean 2h52m old had 14 commits behind it, and a session
 * briefed from it and lost turns to work already committed. Sessions that end without
 * a wrap are the normal way this happens, so the banner assumes it rather than
 * treating it as the exception.
 *
 * null (could not tell) and 0 (looked, found none) both render as nothing here: the
 * banner is a warning surface, and only a positive count is a warning.
 */
function fmtBehind(h: Handoff): string {
  return h.commitsSince ? ` · ${h.commitsSince} commit${h.commitsSince === 1 ? "" : "s"} behind` : "";
}

export function buildBanner(opts: {
  sessionCwd: string;
  projectRoot: string;
  handoffs: Handoff[];
  now?: number;
}): string | null {
  const now = opts.now ?? Date.now();
  const local = opts.handoffs.find(h => h.local);
  const siblings = opts.handoffs.filter(h => !h.local);

  if (!local && siblings.length === 0) return null;

  const line = (h: Handoff) =>
    `\n  - ${relative(opts.projectRoot, h.path)}  (modified ${fmtAge(h.mtimeMs, now)}${fmtBehind(h)})`;

  if (local) {
    let msg = `Continuity: NEXT_SESSION.md present from your last wrap (modified ${fmtAge(local.mtimeMs, now)}${fmtBehind(local)}). Run /next to pick it up.`;
    if (local.commitsSince) {
      msg += ` Commits landed after it was written — some open threads are likely already done.`;
    }
    if (siblings.length > 0) {
      msg += ` ${siblings.length} sibling handoff${siblings.length === 1 ? "" : "s"} also found:`;
      for (const s of siblings) msg += line(s);
    }
    return msg;
  }

  let msg = `Continuity: no NEXT_SESSION.md in this cwd, but ${siblings.length} handoff${siblings.length === 1 ? "" : "s"} in sibling dirs:`;
  for (const s of siblings) msg += line(s);
  return msg;
}

/**
 * Read SessionStart hook payload from stdin and pull out `session_id`.
 * Best-effort: returns null on empty stdin, parse failure, or missing field.
 * Never throws — the hook must remain best-effort and never block the session.
 */
function readSessionIdFromStdin(): string | null {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    const obj = JSON.parse(raw);
    return typeof obj?.session_id === "string" ? obj.session_id : null;
  } catch {
    return null;
  }
}

const DEFAULT_FIRSTFIRE_DIR = join(homedir(), ".claude", "state", "continuity-firstfire");

function formatSlowNote(elapsedMs: number, walks: Map<string, number>): string {
  const totalDirs = Array.from(walks.values()).reduce((a, b) => a + b, 0);
  // Top 2 contributors by walk count.
  const top = Array.from(walks.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, n]) => `./${name} ${n} dirs`)
    .join(", ");
  const secs = (elapsedMs / 1000).toFixed(1);
  const topClause = top.length > 0 ? ` · top: ${top}` : "";
  return ` (slow scan: ${secs}s · ${totalDirs} dirs${topClause})`;
}

function debugLog(line: string) {
  if (!process.env.CONTINUITY_DEBUG) return;
  try {
    appendFileSync(join(homedir(), ".claude", "continuity-hook.log"),
      `${new Date().toISOString()}  ${line}\n`);
  } catch { /* best-effort */ }
}

if (import.meta.main) {
  try {
    // Re-fire suppression: if we've already fired for this session_id, exit silently.
    // Avoids the recurring "briefing buried under N redundant SessionStart fires"
    // failure logged across many wraps in the tooling journal.
    const sessionId = readSessionIdFromStdin();
    if (sessionId) {
      const stateDir = process.env.CONTINUITY_FIRSTFIRE_DIR || DEFAULT_FIRSTFIRE_DIR;
      if (!markFirstFire(stateDir, sessionId)) {
        debugLog(`suppressed re-fire for session_id=${sessionId}`);
        process.stdout.write("{}\n");
        process.exit(0);
      }
    }

    const sessionCwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const projectRoot = findProjectRoot(sessionCwd);
    const { files, elapsedMs, walks } = scanForNextSessionsWithStats(projectRoot);
    // collect() spawns a bounded `git rev-list` per handoff. That is subprocess work
    // on the same blocking path the walk is on, so it belongs in the same budget:
    // timing only the walk under-reports the hook by exactly the part that can hang.
    const t0 = performance.now();
    const banner = buildBanner({ sessionCwd, projectRoot, handoffs: collect(sessionCwd, projectRoot, files) });
    const totalMs = elapsedMs + (performance.now() - t0);
    debugLog(`cwd=${sessionCwd} root=${projectRoot} files=${files.length} elapsedMs=${totalMs.toFixed(1)} walkMs=${elapsedMs.toFixed(1)} emit=${banner === null ? "empty" : "banner"}`);
    if (banner === null) {
      process.stdout.write("{}\n");
    } else {
      const slowMsRaw = Number.parseInt(process.env.CONTINUITY_SLOW_MS ?? "500", 10);
      const slowMs = Number.isFinite(slowMsRaw) ? slowMsRaw : 500;
      const withNote = totalMs > slowMs
        ? banner + formatSlowNote(totalMs, walks)
        : banner;
      process.stdout.write(JSON.stringify({ systemMessage: withNote }) + "\n");
    }
    process.exit(0);
  } catch (e) {
    debugLog(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.stdout.write("{}\n");
    process.exit(0);
  }
}
