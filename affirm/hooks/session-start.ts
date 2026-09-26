#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { classify, loadHashes, normalizeProjectDir } from "../lib/affirm";
import { MAX_IMPORT_DEPTH, buildInstructionGraph, displayPath, type DeepImport } from "../lib/imports";
import { getGitInfo, getMtime, type GitInfo } from "../lib/file-meta";
import { humanizeDelta } from "../lib/humanize";
import { markFirstFire } from "../lib/first-fire";

export type FileMeta = {
  depth: number;
  via: string | null;
  outOfTree: boolean;
  global: boolean;
  ancestor: boolean;
  mtimeMs: number | null;
  git: GitInfo;
};

export type BannerInput = {
  projectDir: string;
  classification: ReturnType<typeof classify>;
  meta: Record<string, FileMeta>;
  deep: DeepImport[];
  now: number;
  /** Who reads it. The terminal gets the call to action; the model gets the fact and a guard. */
  channel?: "user" | "model";
};

// `@from <ref>` / `(global)` / `(ancestor)` / `(out-of-tree)` provenance, shown on every
// state. Global and ancestor roots are out of the tree too, but that is their normal
// place — `(out-of-tree)` reads as a warning about an import that escaped, so they get
// their own words.
function annot(projectDir: string, m: FileMeta | undefined): string {
  if (!m) return "";
  let a = "";
  if (m.via) a += ` ← @from ${displayPath(projectDir, m.via)}`;
  if (m.global) a += " (global)";
  else if (m.ancestor) a += " (ancestor)";
  else if (m.outOfTree) a += " (out-of-tree)";
  return a;
}

function gitDetail(git: GitInfo): string {
  if (!git.inRepo) return "";
  if (!git.lastCommit) {
    if (git.unknown) return " · git state unknown";
    return git.dirty ? " · untracked (uncommitted)" : " · untracked";
  }
  const base = ` · ${git.lastCommit.author}, ${git.lastCommit.date}`;
  if (git.unknown) return `${base} (working tree state unknown)`;
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
  return `ℹ ${deep.length} @import${plural} beyond depth ${MAX_IMPORT_DEPTH} not tracked: ${items.join(", ")}${more}`;
}

export function buildBanner(input: BannerInput): string {
  const { projectDir, classification, meta, deep, now } = input;
  const { approved, added, changed, unreadable = [] } = classification;

  // Global files are silent while affirmed: they are identical in every project, so a
  // ✓ line for one is repetition in every banner. They still surface as ✦/✧ below.
  const visible = approved.filter((f) => !meta[f]?.global);
  if (visible.length + added.length + changed.length + unreadable.length === 0) return "";

  let msg = "Affirm: instruction files in scope:\n";
  for (const f of visible) {
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
  // Could not be hashed, so affirm cannot vouch either way. No call to action:
  // /affirm cannot fix a permission, and Claude Code, running as the same user,
  // most likely cannot load the file either.
  for (const f of unreadable) {
    msg += `  ? ${displayPath(projectDir, f)}${annot(projectDir, meta[f])}  [UNREADABLE — not hashed]\n`;
  }

  if (added.length > 0 || changed.length > 0) {
    msg += input.channel === "model"
      ? "\n⚠ Unaffirmed instruction files are in effect. Affirming is the user's attestation; do not run /affirm -a on their behalf."
      : "\n⚠ Review unaffirmed files, then run /affirm.";
  }
  if (deep.length > 0) {
    msg += "\n" + deepSummary(projectDir, deep);
  }
  return msg.trimEnd();
}

/**
 * Read SessionStart hook payload from stdin: `session_id`, and `source` (startup,
 * resume, clear, compact). Best-effort: a field is null on empty stdin, parse
 * failure, or when missing. Never throws — the hook must never block the session.
 */
function readHookInput(): { sessionId: string | null; source: string | null } {
  try {
    const raw = readFileSync(0, "utf8");
    const obj = raw.trim() ? JSON.parse(raw) : null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return { sessionId: str(obj?.session_id), source: str(obj?.source) };
  } catch {
    return { sessionId: null, source: null };
  }
}

/**
 * One line when this session runs a different version of this plugin than the checkout
 * it is working in. An edit there reaches no session until it ships ("Pushing is not
 * shipping", CLAUDE.md): three sessions ran a stale cached /wrap, one of them the
 * release of the plugin it was running, and pastiche's 0.5.x cache kept minting
 * duplicates after the 0.6.x guard was committed. Duplicated in each plugin's hook,
 * since plugins share no code. "" when the cwd is not this plugin's checkout (or the
 * plugin's own directory in it), the versions match, or a manifest will not read.
 */
export function supersededNote(pluginRoot: string, projectDir: string): string {
  const read = (dir: string) => {
    try {
      return JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const running = read(pluginRoot);
  if (typeof running?.name !== "string" || typeof running?.version !== "string") return "";
  const here = [join(projectDir, running.name), projectDir].map(read).find((m) => m?.name === running.name);
  if (typeof here?.version !== "string" || here.version === running.version) return "";
  const market = /\/plugins\/cache\/([^/]+)\//.exec(pluginRoot)?.[1];
  const update = market ? `\`claude plugin update ${running.name}@${market}\`` : "update the plugin";
  return `${running.name} ${running.version} is running, but this checkout has ${here.version}. ` +
    `It reaches sessions only through the marketplace: push, then ${update}, then /reload-plugins.`;
}

const DEFAULT_FIRSTFIRE_DIR = join(homedir(), ".claude", "state", "affirm-firstfire");

if (import.meta.main) {
  try {
    // Re-fire suppression: if we've already fired for this session_id, exit silently.
    const { sessionId, source } = readHookInput();
    // A compaction summary drops the model's banner: measured 2026-09-26 with a
    // stand-in hook, the model saw no banner after /compact 2 of 2 times, and saw it
    // again when the compact fire went through. So that fire is not suppressed; it
    // carries the model's copy only, since the terminal still has the banner in
    // scrollback.
    let modelOnly = false;
    if (sessionId) {
      const stateDir = process.env.AFFIRM_FIRSTFIRE_DIR || DEFAULT_FIRSTFIRE_DIR;
      if (!markFirstFire(stateDir, sessionId)) {
        if (source !== "compact") {
          process.stdout.write("{}\n");
          process.exit(0);
        }
        modelOnly = true;
      }
    }

    const projectDir = normalizeProjectDir(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const stale = supersededNote(process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dir, ".."), projectDir);
    const withStale = (s: string) => [s, stale].filter(Boolean).join("\n");
    const graph = buildInstructionGraph(projectDir);
    if (graph.files.length === 0 && !stale) {
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
        global: gf.global,
        ancestor: gf.ancestor,
        mtimeMs: null,
        git: { inRepo: false, lastCommit: null, dirty: false },
      };
      if (needDetail.has(gf.path)) {
        base.mtimeMs = getMtime(gf.path);
        base.git = getGitInfo(dirname(gf.path), gf.path); // cwd = file's dir → correct repo, incl. out-of-tree
      }
      meta[gf.path] = base;
    }

    const bannerInput = { projectDir, classification, meta, deep: graph.deep, now: Date.now() };
    const systemMessage = buildBanner(bannerInput);
    // Nothing to say: a project with no instruction files of its own and every global
    // affirmed would otherwise get a header with no lines under it.
    // Two channels, two readers. systemMessage reaches only the terminal, so
    // without the second the model runs under an unaffirmed CLAUDE.md with no way
    // to know. The model's copy swaps the call to action for a guard: affirming is
    // the user's attestation. Instruction content never goes in on either.
    process.stdout.write((systemMessage || stale
      ? JSON.stringify({
          ...(modelOnly ? {} : { systemMessage: withStale(systemMessage) }),
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: withStale(buildBanner({ ...bannerInput, channel: "model" })),
          },
        })
      : "{}") + "\n");
    process.exit(0);
  } catch {
    process.stdout.write("{}\n");
    process.exit(0);
  }
}
