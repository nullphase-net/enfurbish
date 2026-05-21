#!/usr/bin/env bun
import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { homedir } from "node:os";

const MAX_DEPTH = 4;
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "vendor", "dist", "build", "target",
  "__pycache__", ".venv", "venv",
]);

export type NextSessionFile = { path: string; mtimeMs: number };

export function scanForNextSessions(root: string, maxDepth = MAX_DEPTH): NextSessionFile[] {
  const out: NextSessionFile[] = [];
  function walk(dir: string, depth: number) {
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
        if (IGNORE_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && e.name === "NEXT_SESSION.md") {
        try {
          const st = statSync(full);
          out.push({ path: full, mtimeMs: st.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(root, 0);
  return out;
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
    const files = scanForNextSessions(projectRoot);
    const banner = buildBanner({ sessionCwd, projectRoot, files });
    debugLog(`cwd=${sessionCwd} root=${projectRoot} files=${files.length} emit=${banner === null ? "empty" : "banner"}`);
    if (banner === null) {
      process.stdout.write("{}\n");
    } else {
      process.stdout.write(JSON.stringify({ systemMessage: banner }) + "\n");
    }
    process.exit(0);
  } catch (e) {
    debugLog(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.stdout.write("{}\n");
    process.exit(0);
  }
}
