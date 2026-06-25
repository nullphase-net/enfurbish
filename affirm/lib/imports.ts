import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// How deep @import following goes. Roots are depth 0, so this follows two levels
// of imports. Imports discovered deeper than this are reported (graph.deep), not hashed.
export const MAX_IMPORT_DEPTH = 2;

export type GraphFile = {
  path: string;
  depth: number;
  via: string | null; // referrer (absolute), null for roots
  outOfTree: boolean; // not under the project root
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

function walkRules(dir: string, out: string[]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkRules(full, out);
    else if (e.isFile()) out.push(full);
  }
}

function collectRoots(projectRoot: string): string[] {
  const out: string[] = [];
  const top = join(projectRoot, "CLAUDE.md");
  if (existsSync(top) && safeIsFile(top)) out.push(top);
  const rulesDir = join(projectRoot, ".claude", "rules");
  if (existsSync(rulesDir) && safeIsDir(rulesDir)) walkRules(rulesDir, out);
  return out.sort();
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

  type Node = { path: string; depth: number; via: string | null };
  const queue: Node[] = collectRoots(root).map((p) => ({ path: realOrSelf(p), depth: 0, via: null }));

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node.path)) continue;
    visited.add(node.path);
    const outOfTree = !(node.path === root || node.path.startsWith(root + sep));
    files.push({ path: node.path, depth: node.depth, via: node.via, outOfTree });

    for (const raw of importsOf(node.path)) {
      const resolved = realOrSelf(resolveImport(raw, dirname(node.path)));
      if (!safeIsFile(resolved)) continue; // skip missing / non-file imports
      if (node.depth < maxDepth) {
        if (!visited.has(resolved)) queue.push({ path: resolved, depth: node.depth + 1, via: node.path });
      } else if (!visited.has(resolved) && !deepSeen.has(resolved)) {
        // beyond the follow cap: report it, don't hash it
        deepSeen.add(resolved);
        deep.push({ via: node.path, raw });
      }
    }
  }

  return { files, deep };
}
