import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// How deep @import following goes. Roots are depth 0. Four is Claude Code's own cap
// ("a maximum depth of four hops"; measured 2026-09-26 on 2.1.283: i1-i4 loaded, i5 did
// not). Imports discovered deeper than this are reported (graph.deep), not hashed.
export const MAX_IMPORT_DEPTH = 4;

export type GraphFile = {
  path: string;
  depth: number;
  via: string | null; // referrer (absolute), null for roots
  outOfTree: boolean; // not under the project root
  global: boolean; // reached from a global (~/.claude) root, not a project one
  ancestor: boolean; // a root in a directory above the project, not one of its imports
};

export type DeepImport = {
  via: string; // the depth-cap file that referenced it
  raw: string; // the @path as written
};

export type InstructionGraph = {
  files: GraphFile[];
  deep: DeepImport[];
};

// Strip fenced + inline code so literal "@foo" mentions aren't treated as imports
// (matches Claude Code, which ignores imports inside code spans/blocks).
function stripCode(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`+[^`\n]*`+/g, "");
}

// @ must not be preceded by a word/path char, so emails (you@host) don't match.
const IMPORT_RE = /(?<![\w./~@-])@([A-Za-z0-9._~/\-]+)/g;

export function parseImports(content: string): string[] {
  const out: string[] = [];
  for (const m of stripCode(content).matchAll(IMPORT_RE)) out.push(m[1]!);
  return out;
}

export function resolveImport(raw: string, fromDir: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  if (isAbsolute(raw)) return raw;
  return resolve(fromDir, raw);
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function safeIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Project-relative for in-tree files; ~-abbreviated home or absolute for out-of-tree. */
export function displayPath(projectDir: string, abs: string): string {
  const rel = relative(projectDir, abs);
  if (rel && !rel.startsWith("..")) return rel;
  const home = homedir();
  if (abs === home || abs.startsWith(home + sep)) return "~" + abs.slice(home.length);
  return abs;
}

// Follows symlinks, files and directories both, because Claude Code's loader does:
// ".claude/rules/ supports symlinks" (memory docs, with a symlinked shared-rules
// directory as the example). Skipping them left that shape loading unwatched
// (symbion e36). `seen` holds the real path of every directory walked, so a link
// back up the tree ends the walk instead of recursing forever.
function walkRules(dir: string, out: string[], seen = new Set<string>()) {
  const real = realOrSelf(dir);
  if (seen.has(real)) return;
  seen.add(real);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    // A dirent describes the link itself; stat follows it. A dangling link is neither.
    const link = e.isSymbolicLink();
    if (link ? safeIsDir(full) : e.isDirectory()) walkRules(full, out, seen);
    else if (link ? safeIsFile(full) : e.isFile()) out.push(full);
  }
}

/** Where the user-global instruction files live. `AFFIRM_GLOBAL_DIR` overrides it for tests. */
export function globalDir(): string {
  return process.env.AFFIRM_GLOBAL_DIR || join(homedir(), ".claude");
}

function rootsAt(dir: string, names: string[], rulesDir: string | null): string[] {
  const out: string[] = [];
  for (const n of names) {
    const p = join(dir, n);
    if (safeIsFile(p)) out.push(p);
  }
  if (rulesDir && safeIsDir(rulesDir)) walkRules(rulesDir, out);
  return out.sort();
}

// What Claude Code loads at launch, and therefore what affirm roots the graph at.
// Source: code.claude.com/docs/en/memory, checked 2026-09-26, and measured the same day on
// 2.1.283 with an InstructionsLoaded hook from a dir two levels under a non-repo parent:
//   - cwd and EVERY directory above it, past the git root to /: CLAUDE.md,
//     .claude/CLAUDE.md, CLAUDE.local.md, .claude/rules/** (ancestor rules are not in
//     the docs; the measurement loaded them)
//   - AGENTS.md, .claude/AGENTS.md in the same dirs, only when none of the three above
//     exists anywhere in them (the default instructionFiles mode; see agentsMdLoads)
//   - ~/.claude/CLAUDE.md, ~/.claude/rules/**
//   - their @imports, four hops (MAX_IMPORT_DEPTH)
// Not watched: the managed-policy CLAUDE.md (root-owned, not the user's to attest);
// subdirectory files, which load on demand; --add-dir dirs, which need an opt-in env var.
const CLAUDE_MD_FAMILY = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];
const AGENTS_MD = ["AGENTS.md", join(".claude", "AGENTS.md")];

/** The cwd first, then each parent up to the filesystem root. */
function dirsUp(dir: string): string[] {
  const out = [dir];
  for (let d = dir; dirname(d) !== d; d = dirname(d)) out.push(dirname(d));
  return out;
}

/**
 * Claude Code's `instructionFiles` option (`pluginConfigs["agents-md@builtin"]`), read
 * from user settings only. It is also honoured in a --settings file and managed
 * settings, which a hook cannot see; project and local settings ignore it.
 */
function instructionFilesSetting(): unknown {
  try {
    const s = JSON.parse(readFileSync(join(globalDir(), "settings.json"), "utf8"));
    return s?.pluginConfigs?.["agents-md@builtin"]?.options?.instructionFiles;
  } catch {
    return undefined;
  }
}

// The global CLAUDE.md and rules files do not count toward "has a CLAUDE.md" (docs).
// A value outside the documented set is unknown, not a no: the file stays watched.
function agentsMdLoads(hasClaudeMd: boolean): boolean {
  const mode = instructionFilesSetting();
  if (mode === "claude-md" || mode === "managed-only") return false;
  if (mode === undefined || mode === "claude-md-or-agents-md") return !hasClaudeMd;
  return true;
}

type Root = { path: string; global: boolean; ancestor: boolean };

// Project roots come first so that when the same file is reachable both ways, the
// BFS's first visit is the project one and the file stays visible in the banner.
// The exception is a file that IS a global root: it is queued at depth 0 and wins
// over a project's depth-1 import of it, which is right — it loads in every project
// regardless, so a ✓ line for it is the repetition the gating exists to cut. For the
// same reason a global root reached as an ancestor's file (a project under $HOME sees
// ~/.claude/CLAUDE.md as its home dir's .claude/CLAUDE.md) is left to the global list.
function collectRoots(projectRoot: string): Root[] {
  const g = globalDir();
  const glob = rootsAt(g, ["CLAUDE.md"], join(g, "rules"));
  const isGlobal = new Set(glob.map(realOrSelf));

  const dirs = dirsUp(projectRoot);
  const proj = dirs.map((d) => rootsAt(d, CLAUDE_MD_FAMILY, join(d, ".claude", "rules")));
  const hasClaudeMd = dirs.some((d) => CLAUDE_MD_FAMILY.some((n) => safeIsFile(join(d, n))));
  if (agentsMdLoads(hasClaudeMd)) {
    dirs.forEach((d, i) => proj[i]!.push(...rootsAt(d, AGENTS_MD, null)));
  }

  return [
    ...proj.flatMap((paths, i) =>
      paths.filter((p) => !isGlobal.has(realOrSelf(p))).map((path) => ({ path, global: false, ancestor: i > 0 })),
    ),
    ...glob.map((path) => ({ path, global: true, ancestor: false })),
  ];
}

function importsOf(file: string): string[] {
  if (!file.endsWith(".md")) return []; // only markdown carries @imports
  try {
    return parseImports(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

export function buildInstructionGraph(projectDir: string, maxDepth = MAX_IMPORT_DEPTH): InstructionGraph {
  const root = realOrSelf(projectDir);
  const files: GraphFile[] = [];
  const deep: DeepImport[] = [];
  const visited = new Set<string>();
  const deepSeen = new Set<string>();

  type Node = { path: string; depth: number; via: string | null; global: boolean; ancestor: boolean };
  const queue: Node[] = collectRoots(root).map((r) => ({
    path: realOrSelf(r.path),
    depth: 0,
    via: null,
    global: r.global,
    ancestor: r.ancestor,
  }));

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.path)) continue;
    visited.add(node.path);
    const outOfTree = !(node.path === root || node.path.startsWith(root + sep));
    files.push({
      path: node.path,
      depth: node.depth,
      via: node.via,
      outOfTree,
      global: node.global,
      ancestor: node.ancestor,
    });

    for (const raw of importsOf(node.path)) {
      const resolved = realOrSelf(resolveImport(raw, dirname(node.path)));
      if (!safeIsFile(resolved)) continue; // skip missing / non-file imports
      if (node.depth < maxDepth) {
        if (!visited.has(resolved))
          queue.push({ path: resolved, depth: node.depth + 1, via: node.path, global: node.global, ancestor: false });
      } else if (!visited.has(resolved) && !deepSeen.has(resolved)) {
        // beyond the follow cap: report it, don't hash it
        deepSeen.add(resolved);
        deep.push({ via: node.path, raw });
      }
    }
  }

  return { files, deep };
}
