#!/usr/bin/env bun
import { dirname, relative } from "node:path";
import {
  HASH_FILE,
  approveAll,
  loadHashes,
  normalizeProjectDir,
  revokeProject,
  sha256OfFile,
} from "./affirm";
import { buildInstructionGraph, displayPath, type InstructionGraph } from "./imports";
import { getMtime, getGitInfo, commitsTouching, type GitInfo } from "./file-meta";

function usage(): string {
  return [
    "Usage:",
    "  affirm                show status, mtime, and git info for instruction files in cwd",
    "  affirm -a, --apply    record SHA-256 hashes (the attestation)",
    "  affirm -r, --revoke   remove affirmation for files in cwd",
    "  affirm --since <iso>  which instruction files changed after <iso>, and how",
    "  affirm -h, --help     show this message",
  ].join("\n");
}

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fmtGit(info: GitInfo): string | null {
  if (!info.inRepo) return null;
  if (!info.lastCommit) {
    return info.dirty ? "untracked (uncommitted)" : "untracked";
  }
  const base = `${info.lastCommit.author} — last commit ${info.lastCommit.date}`;
  return info.dirty ? `${base} (uncommitted local changes)` : base;
}

function renderDetails(
  projectDir: string,
  graph: InstructionGraph,
  stored: Record<string, string>,
  out: (s: string) => void,
) {
  out(`Instruction files in ${projectDir}:`);
  out("");
  for (const gf of graph.files) {
    out(`  ${displayPath(projectDir, gf.path)}`);
    out(`    status:   ${statusOf(gf.path, stored)}`);
    const mt = getMtime(gf.path);
    if (mt !== null) out(`    modified: ${fmtTs(mt)}`);
    const git = fmtGit(getGitInfo(dirname(gf.path), gf.path)); // cwd = file's dir → correct repo, incl. out-of-tree
    if (git !== null) out(`    git:      ${git}`);
    if (gf.via) out(`    import:   from ${displayPath(projectDir, gf.via)} (depth ${gf.depth})`);
    if (gf.outOfTree) out(`    scope:    out-of-tree`);
    out("");
  }
  if (graph.deep.length > 0) {
    const list = graph.deep.map((d) => `${displayPath(projectDir, d.via)} → ${d.raw}`).join(", ");
    out(`@imports beyond depth 2 (not tracked): ${list}`);
    out("");
  }
  out("Run /affirm -a to record current hashes, /affirm -r to revoke.");
}

/**
 * Which instruction files were touched after `iso`, and what the commits say.
 *
 * `/wrap` runs this with the session's `session_start`. The gate matters: a CHANGED
 * warning at the *next* session start is pure alert fatigue when the user is the one
 * who changed the file this session — they already know. Measured over eight wraps,
 * 6 positives / 2 negatives, and the mtime window separates them cleanly.
 *
 * It reports rather than offers. Two sessions logging this action ended with nobody
 * at the keyboard, and an offer assumes someone is there to answer it; a diff summary
 * is still worth writing into the retro when it is read hours later.
 */
export function renderSince(
  projectDir: string,
  graph: InstructionGraph,
  stored: Record<string, string>,
  iso: string,
  out: (s: string) => void,
): void {
  const cutoff = Date.parse(iso);
  if (!(cutoff > 0)) {
    out(`unparseable timestamp: ${iso}`);
    return;
  }
  const touched = graph.files.filter((gf) => (getMtime(gf.path) ?? 0) > cutoff);
  const total = graph.files.length;
  if (touched.length === 0) {
    out(`0 of ${total} instruction file${total === 1 ? "" : "s"} touched since ${iso}`);
    return;
  }

  out(`${touched.length} of ${total} touched since ${iso}`);
  let needsReview = false;
  for (const gf of touched) {
    const status = statusOf(gf.path, stored);
    if (status !== "affirmed") needsReview = true;
    const subjects = commitsTouching(dirname(gf.path), gf.path, iso);
    const commits = subjects.length
      ? `  ${subjects.length} commit${subjects.length === 1 ? "" : "s"}: ${subjects.join("; ")}`
      : "  no commits in window";
    out(`  ${displayPath(projectDir, gf.path)}  ${status}${commits}`);
  }
  // Only when the hash actually moved. A file edited and reverted within the session
  // is touched but still affirmed, and prompting for it would be the alert fatigue
  // this whole gate exists to avoid.
  if (needsReview) out(`run /affirm -a after reviewing`);
}

function statusOf(file: string, stored: Record<string, string>): string {
  const prev = stored[file];
  if (prev === undefined) return "NEW (not yet affirmed)";
  let cur: string;
  try {
    cur = sha256OfFile(file);
  } catch {
    return "unreadable";
  }
  if (prev !== cur) return "CHANGED (hash mismatch)";
  return "affirmed";
}

export type CliOpts = {
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
  hashPath?: string;
};

export function runCli(argv: string[], opts: CliOpts): number {
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    opts.out(usage());
    return 0;
  }
  const wantsApply = args.has("-a") || args.has("--apply");
  const wantsRevoke = args.has("-r") || args.has("--revoke");
  if (wantsApply && wantsRevoke) {
    opts.err(`-a/--apply and -r/--revoke are mutually exclusive\n\n${usage()}`);
    return 2;
  }
  const arg = argv[0];

  const hashPath = opts.hashPath ?? HASH_FILE;
  const projectDir = normalizeProjectDir(opts.cwd);
  const graph = buildInstructionGraph(projectDir);
  if (graph.files.length === 0) {
    opts.out(`No CLAUDE.md or .claude/rules/ files found in ${projectDir}`);
    return 0;
  }

  if (arg === "--revoke" || arg === "-r") {
    const { revoked } = revokeProject(projectDir, hashPath);
    if (revoked.length === 0) {
      opts.out(`No prior affirmations to revoke in ${projectDir}.`);
    } else {
      opts.out(`Revoked ${revoked.length} affirmation${revoked.length === 1 ? "" : "s"} in ${projectDir}:`);
      for (const f of revoked) opts.out(`  ${relative(projectDir, f)}`);
      opts.out("");
      opts.out("Next session will surface these as unaffirmed.");
    }
    return 0;
  }

  if (arg === "-a" || arg === "--apply") {
    const { approved } = approveAll(projectDir, hashPath);
    opts.out(`Affirmed ${approved.length} file${approved.length === 1 ? "" : "s"} in ${projectDir}:`);
    for (const { path, hash } of approved) {
      opts.out(`  ${relative(projectDir, path)}  (${hash.slice(0, 12)}…)`);
    }
    return 0;
  }

  if (arg === "--since") {
    const iso = argv[1];
    if (!iso) {
      opts.err(`--since needs an ISO timestamp\n\n${usage()}`);
      return 2;
    }
    renderSince(projectDir, graph, loadHashes(hashPath), iso, opts.out);
    return 0;
  }

  if (arg === undefined) {
    renderDetails(projectDir, graph, loadHashes(hashPath), opts.out);
    return 0;
  }

  opts.err(`Unknown argument: ${arg}\n\n${usage()}`);
  return 2;
}

if (import.meta.main) {
  const code = runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
  });
  process.exit(code);
}
