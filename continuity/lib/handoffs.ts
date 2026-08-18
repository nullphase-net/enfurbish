#!/usr/bin/env bun
/**
 * Everything that knows where NEXT_SESSION.md files live and who last wrote one.
 *
 * The scan moved here from hooks/session-start.ts so `/next` can reuse it: a
 * 2026-08-18 wrap logged `/next` reading the cwd-local pointer while a newer
 * sibling — written by a session whose cwd was a subdirectory of the same
 * project — sat invisible, and the user picked up a thread that had finished
 * the previous evening.
 *
 * The wrap-generation stamp answers a second question the same file raises:
 * did the assistant write this, or did a human edit it? `/wrap` step 5 used
 * mtime for that and misfired both ways (assistant edits via Bash look like
 * user edits; assistant edits via Write look like user edits too, since both
 * land after session_start). A content hash the wrap itself stamps in is the
 * only signal that survives whichever tool did the writing.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { getIgnoredDirs } from "./gitignore";
import { humanizeDelta } from "./humanize";

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

// --- wrap-generation stamp -------------------------------------------------

const STAMP = /^<!-- wrap-generation ([0-9a-f]{16}) -->$/m;

/** Content hash, computed over the file with any existing stamp line removed. */
export function generation(text: string): string {
  const bare = text.replace(STAMP, "").replace(/\s+$/, "");
  return createHash("sha256").update(bare).digest("hex").slice(0, 16);
}

/** The file's content with a current stamp as its last line. Idempotent. */
export function stamp(text: string): string {
  const bare = text.replace(STAMP, "").replace(/\s+$/, "");
  return `${bare}\n\n<!-- wrap-generation ${generation(bare)} -->\n`;
}

export type Ownership = "assistant" | "edited" | "unstamped";

/**
 * `assistant` — content still matches the stamp `/wrap` wrote, so nothing has
 * touched it since; the per-item merge may proceed.
 * `edited` — stamped, but the content moved; someone (probably the user) wrote
 * to it and their notes must not be clobbered.
 * `unstamped` — written before this mechanism existed, or by hand. Caller falls
 * back to whatever heuristic it had.
 */
export function ownership(text: string): Ownership {
  const found = STAMP.exec(text);
  if (!found) return "unstamped";
  return found[1] === generation(text) ? "assistant" : "edited";
}

// --- reporting -------------------------------------------------------------

const LAST_WRAPPED = /^\*\*Last wrapped:\*\*\s*(\S+)/m;

/**
 * Render the header block. The single place that shape is written — `LAST_WRAPPED`
 * above parses it back, and a header composed from memory that drifts to
 * `**Last wrap:**` degrades the report to `no header` without anything noticing.
 * The body below it is prose the model composes; nothing parses that, so nothing
 * needs to own it.
 */
export function formatHeader(opts: {
  slug: string;
  wrapped: string;
  session: string;
  retro?: string;
}): string {
  return [
    `# Next session — ${opts.slug}`,
    "",
    `**Last wrapped:** ${opts.wrapped} (session ${opts.session})`,
    `**Retro:** ${opts.retro || "none (-q)"}`,
  ].join("\n");
}

export type Handoff = {
  path: string;
  rel: string;
  mtimeMs: number;
  /** ISO timestamp from the file's `**Last wrapped:**` header, if it has one. */
  wrapped: string | null;
  local: boolean;
  ownership: Ownership;
};

export function collect(sessionCwd: string, projectRoot: string): Handoff[] {
  const localPath = join(sessionCwd, "NEXT_SESSION.md");
  return scanForNextSessions(projectRoot)
    .map(f => {
      let text = "";
      try { text = readFileSync(f.path, "utf8"); } catch { /* listed, unreadable */ }
      return {
        path: f.path,
        rel: relative(projectRoot, f.path) || f.path,
        mtimeMs: f.mtimeMs,
        wrapped: LAST_WRAPPED.exec(text)?.[1] ?? null,
        local: f.path === localPath,
        ownership: ownership(text),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Terse, state-pivoting report. The load-bearing line is the header: when the
 * cwd-local pointer is not the newest one, say so and say by how much, because
 * that is the exact condition under which reading only the local file is wrong.
 */
export function report(hs: Handoff[], projectRoot: string, now: number): string {
  const head = `${hs.length} handoff${hs.length === 1 ? "" : "s"} · root ${projectRoot}`;
  if (hs.length === 0) return head;

  const newest = hs[0];
  const local = hs.find(h => h.local);
  const pivot = !local
    ? " · none in cwd"
    : local === newest
      ? ""
      : ` · local is ${humanizeDelta(newest.mtimeMs - local.mtimeMs)} staler than newest`;

  const width = Math.max(...hs.map(h => h.rel.length + (h.local ? 8 : 0)));
  const lines = hs.map(h => {
    const name = `${h.rel}${h.local ? " [local]" : ""}`.padEnd(width);
    const age = `${humanizeDelta(now - h.mtimeMs)} ago`.padEnd(9);
    const wrapped = h.wrapped ?? "no header";
    // A pointer whose file moved after its own `Last wrapped` header carries
    // mid-session edits the header does not describe.
    const drift = h.wrapped && Date.parse(h.wrapped) > 0
      ? h.mtimeMs - Date.parse(h.wrapped) > 60_000
        ? `  +${humanizeDelta(h.mtimeMs - Date.parse(h.wrapped))} after header`
        : ""
      : "";
    const own = h.ownership === "unstamped" ? "" : `  stamp:${h.ownership}`;
    return `${h === newest ? "*" : " "} ${name}  ${age} wrapped ${wrapped}${own}${drift}`;
  });
  return [head + pivot, ...lines].join("\n");
}

const USAGE = `usage: handoffs.ts [--cwd <dir>]        list NEXT_SESSION.md files under the project root
       --stamp <path>              rewrite <path> with a current wrap-generation stamp
       --check <path>              assistant | edited | unstamped
       --header <slug> <iso-ts> <sid8> [retro]
                                   print the canonical NEXT_SESSION.md header block`;

export function main(
  args: string[],
  now = Date.now(),
  emit: (s: string) => void = s => void process.stdout.write(`${s}\n`),
): number {
  const flag = args[0];

  if (flag === "--header") {
    const [, slug, wrapped, session, retro] = args;
    if (!slug || !wrapped || !session) return process.stderr.write(`${USAGE}\n`), 2;
    return emit(formatHeader({ slug, wrapped, session, retro })), 0;
  }

  if (flag === "--stamp" || flag === "--check") {
    const path = args[1];
    if (!path) return process.stderr.write(`${USAGE}\n`), 2;
    if (!existsSync(path)) return emit(`absent ${path}`), 0;
    const text = readFileSync(path, "utf8");
    if (flag === "--check") return emit(ownership(text)), 0;
    const next = stamp(text);
    if (next !== text) writeFileSync(path, next);
    return emit(`stamped ${generation(text)} ${path}`), 0;
  }

  if (flag && flag !== "--cwd") return process.stderr.write(`${USAGE}\n`), 2;

  const cwd = (flag === "--cwd" && args[1]) || process.cwd();
  const root = findProjectRoot(cwd);
  emit(report(collect(cwd, root), root, now));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
