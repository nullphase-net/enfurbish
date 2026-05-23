#!/usr/bin/env bun
import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";
import { getIgnoredDirs } from "../lib/gitignore";

const MAX_DEPTH = 4;
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "vendor", "dist", "build", "target",
  "__pycache__", ".venv", "venv",
]);

export type NextSessionFile = { path: string; mtimeMs: number };

export type ScanResult = {
  files: NextSessionFile[];
  elapsedMs: number;
  /** Per-toplevel-segment walk counts (subdirs entered under that toplevel). */
  walks: Map<string, number>;
};

export function scanForNextSessions(root: string, maxDepth = MAX_DEPTH): NextSessionFile[] {
  return scanForNextSessionsWithStats(root, maxDepth).files;
}

export function scanForNextSessionsWithStats(root: string, maxDepth = MAX_DEPTH): ScanResult {
  const out: NextSessionFile[] = [];
  const ignored = getIgnoredDirs(root);
  const walks = new Map<string, number>();
  const start = performance.now();
  function walk(dir: string, depth: number, topLevel: string | null) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // Cheap-first ordering: name-based checks before the absolute-path
        // Set lookup, which involves the `full` string we already built but
        // would otherwise want to avoid for skipped dirs.
        if (e.name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(e.name)) continue;
        if (ignored.has(full)) continue;
        const nextTop = topLevel ?? e.name;
        walks.set(nextTop, (walks.get(nextTop) ?? 0) + 1);
        walk(full, depth + 1, nextTop);
      } else if (e.isFile() && e.name === "NEXT_SESSION.md") {
        try {
          const st = statSync(full);
          out.push({ path: full, mtimeMs: st.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(root, 0, null);
  return { files: out, elapsedMs: performance.now() - start, walks };
}

export function findProjectRoot(start: string): string {
  const home = homedir();
  let cur = start;
  while (true) {
    if (existsSync(join(cur, ".git")) || existsSync(join(cur, "CLAUDE.md"))) {
      return cur;
    }
    if (cur === home || cur === "/" || cur === "") return start;
    const parent = join(cur, "..");
    if (parent === cur) return start;
    cur = parent;
  }
}

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export function buildBanner(opts: {
  sessionCwd: string;
  projectRoot: string;
  files: NextSessionFile[];
}): string | null {
  const localPath = join(opts.sessionCwd, "NEXT_SESSION.md");
  const local = opts.files.find(f => f.path === localPath);
  const siblings = opts.files.filter(f => f.path !== localPath);

  if (!local && siblings.length === 0) return null;

  if (local) {
    let msg = `Continuity: NEXT_SESSION.md present from your last wrap (modified ${fmtTs(local.mtimeMs)} UTC). Run /next to pick it up.`;
    if (siblings.length > 0) {
      msg += ` ${siblings.length} sibling handoff${siblings.length === 1 ? "" : "s"} also found:`;
      for (const s of siblings) {
        msg += `\n  - ${relative(opts.projectRoot, s.path)}  (modified ${fmtTs(s.mtimeMs)})`;
      }
    }
    return msg;
  }

  let msg = `Continuity: no NEXT_SESSION.md in this cwd, but ${siblings.length} handoff${siblings.length === 1 ? "" : "s"} in sibling dirs:`;
  for (const s of siblings) {
    msg += `\n  - ${relative(opts.projectRoot, s.path)}  (modified ${fmtTs(s.mtimeMs)})`;
  }
  return msg;
}

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
    const sessionCwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const projectRoot = findProjectRoot(sessionCwd);
    const { files, elapsedMs, walks } = scanForNextSessionsWithStats(projectRoot);
    const banner = buildBanner({ sessionCwd, projectRoot, files });
    debugLog(`cwd=${sessionCwd} root=${projectRoot} files=${files.length} elapsedMs=${elapsedMs.toFixed(1)} emit=${banner === null ? "empty" : "banner"}`);
    if (banner === null) {
      process.stdout.write("{}\n");
    } else {
      const slowMsRaw = Number.parseInt(process.env.CONTINUITY_SLOW_MS ?? "500", 10);
      const slowMs = Number.isFinite(slowMsRaw) ? slowMsRaw : 500;
      const withNote = elapsedMs > slowMs
        ? banner + formatSlowNote(elapsedMs, walks)
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
