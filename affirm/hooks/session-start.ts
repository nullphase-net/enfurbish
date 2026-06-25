#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { classify, loadHashes, normalizeProjectDir } from "../lib/affirm";
import { buildInstructionGraph, displayPath, type DeepImport } from "../lib/imports";
import { getGitInfo, getMtime, type GitInfo } from "../lib/file-meta";
import { humanizeDelta } from "../lib/humanize";
import { markFirstFire } from "../lib/first-fire";

export type FileMeta = {
  depth: number;
  via: string | null;
  outOfTree: boolean;
  mtimeMs: number | null;
  git: GitInfo;
};

export type BannerInput = {
  projectDir: string;
  classification: ReturnType<typeof classify>;
  meta: Record<string, FileMeta>;
  deep: DeepImport[];
  now: number;
};

// `@from <ref>` / `(out-of-tree)` provenance, shown on every state.
function annot(projectDir: string, m: FileMeta | undefined): string {
  if (!m) return "";
  let a = "";
  if (m.via) a += ` ← @from ${displayPath(projectDir, m.via)}`;
  if (m.outOfTree) a += " (out-of-tree)";
  return a;
}

function gitDetail(git: GitInfo): string {
  if (!git.inRepo) return "";
  if (!git.lastCommit) return git.dirty ? " · untracked (uncommitted)" : " · untracked";
  const base = ` · ${git.lastCommit.author}, ${git.lastCommit.date}`;
  return git.dirty ? `${base} (uncommitted)` : base;
}

// Only NEW/CHANGED files get a detail line — that's where mtime+git inform the trust call.
function detailLine(m: FileMeta, now: number): string {
  const age = m.mtimeMs != null ? `${humanizeDelta(now - m.mtimeMs)} ago` : "unknown";
  return `      modified ${age}${gitDetail(m.git)}`;
}

function deepSummary(projectDir: string, deep: DeepImport[]): string {
  const CAP = 5;
  const items = deep.slice(0, CAP).map((d) => `${displayPath(projectDir, d.via)} → ${d.raw}`);
  const more = deep.length > CAP ? `, +${deep.length - CAP} more` : "";
  const plural = deep.length === 1 ? "" : "s";
  return `ℹ ${deep.length} @import${plural} beyond depth 2 not tracked: ${items.join(", ")}${more}`;
}

export function buildBanner(input: BannerInput): string {
  const { projectDir, classification, meta, deep, now } = input;
  const { approved, added, changed } = classification;

  let msg = "Affirm: instruction files in this project:\n";
  for (const f of approved) {
    msg += `  ✓ ${displayPath(projectDir, f)}${annot(projectDir, meta[f])}\n`;
  }
  for (const f of added) {
    msg += `  ✦ ${displayPath(projectDir, f)}${annot(projectDir, meta[f])}  [NEW — unaffirmed]\n`;
    if (meta[f]) msg += detailLine(meta[f]!, now) + "\n";
  }
  for (const f of changed) {
    msg += `  ✧ ${displayPath(projectDir, f)}${annot(projectDir, meta[f])}  [CHANGED — unaffirmed]\n`;
    if (meta[f]) msg += detailLine(meta[f]!, now) + "\n";
  }

  if (added.length > 0 || changed.length > 0) {
    msg += "\n⚠ Review unaffirmed files, then run /affirm.";
  }
  if (deep.length > 0) {
    msg += "\n" + deepSummary(projectDir, deep);
  }
  return msg.trimEnd();
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

const DEFAULT_FIRSTFIRE_DIR = join(homedir(), ".claude", "state", "affirm-firstfire");

if (import.meta.main) {
  try {
    // Re-fire suppression: if we've already fired for this session_id, exit silently.
    const sessionId = readSessionIdFromStdin();
    if (sessionId) {
      const stateDir = process.env.AFFIRM_FIRSTFIRE_DIR || DEFAULT_FIRSTFIRE_DIR;
      if (!markFirstFire(stateDir, sessionId)) {
        process.stdout.write("{}\n");
        process.exit(0);
      }
    }

    const projectDir = normalizeProjectDir(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const graph = buildInstructionGraph(projectDir);
    if (graph.files.length === 0) {
      process.stdout.write("{}\n");
      process.exit(0);
    }
    const files = graph.files.map((f) => f.path).sort();
    const classification = classify(files, loadHashes());

    // Compute mtime/git only for NEW/CHANGED files — the only ones that get a detail line.
    const needDetail = new Set([...classification.added, ...classification.changed]);
    const meta: Record<string, FileMeta> = {};
    for (const gf of graph.files) {
      const base: FileMeta = {
        depth: gf.depth,
        via: gf.via,
        outOfTree: gf.outOfTree,
        mtimeMs: null,
        git: { inRepo: false, lastCommit: null, dirty: false },
      };
      if (needDetail.has(gf.path)) {
        base.mtimeMs = getMtime(gf.path);
        base.git = getGitInfo(dirname(gf.path), gf.path); // cwd = file's dir → correct repo, incl. out-of-tree
      }
      meta[gf.path] = base;
    }

    const systemMessage = buildBanner({ projectDir, classification, meta, deep: graph.deep, now: Date.now() });
    process.stdout.write(JSON.stringify({ systemMessage }) + "\n");
    process.exit(0);
  } catch {
    process.stdout.write("{}\n");
    process.exit(0);
  }
}
