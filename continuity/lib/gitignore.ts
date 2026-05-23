// continuity/lib/gitignore.ts
// All git invocations use node:child_process.spawnSync; do NOT substitute
// Bun.spawnSync or Bun.spawn (different timeout semantics).
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
}

/**
 * One `git ls-files --others --ignored --exclude-standard --directory -z` call.
 * Returns an absolute-path Set of *directories only* (entries with trailing `/`
 * in git output). Empty Set on any error or outside a git repo.
 *
 * Critical: the trailing-`/` filter is what makes this safe to use for scan
 * pruning. A gitignored *file* named NEXT_SESSION.md must still be findable
 * by the scan, so file entries from git ls-files are deliberately discarded.
 */
export function getIgnoredDirs(projectRoot: string): Set<string> {
  const out = new Set<string>();
  const r = git(projectRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ]);
  if (r.code !== 0) return out;
  for (const entry of r.stdout.split("\0")) {
    if (entry.length === 0) continue;
    // Directory entries end with "/"; files do not.
    if (!entry.endsWith("/")) continue;
    const rel = entry.slice(0, -1); // strip trailing "/"
    out.add(join(projectRoot, rel));
  }
  return out;
}

/**
 * `git check-ignore -q <relPath>` returns exit 0 iff the path is gitignored.
 * Returns false on any other exit (including non-git-repo, file not present, etc.).
 */
export function isFileIgnored(projectRoot: string, relPath: string): boolean {
  const r = git(projectRoot, ["check-ignore", "-q", "--", relPath]);
  return r.code === 0;
}

/**
 * `git ls-files --error-unmatch <relPath>` returns exit 0 iff the path is
 * tracked. Returns false on any other exit.
 */
export function isFileTracked(projectRoot: string, relPath: string): boolean {
  const r = git(projectRoot, ["ls-files", "--error-unmatch", "--", relPath]);
  return r.code === 0;
}

function isInRepo(projectRoot: string): boolean {
  return git(projectRoot, ["rev-parse", "--is-inside-work-tree"]).code === 0;
}

function suggestLine(projectRoot: string, relPath: string, forWrite: boolean): string {
  if (!forWrite) return "";
  if (!isInRepo(projectRoot)) return "";
  if (isFileIgnored(projectRoot, relPath)) return "";
  if (isFileTracked(projectRoot, relPath)) return "";
  return `  Note: ${relPath} isn't gitignored — consider adding \`${relPath}\` to .gitignore so it stays out of commits.`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--suggest-line");
  if (idx === -1 || argv[idx + 1] === undefined) {
    // Unknown / missing args: stay silent, exit 0. The skill calls us;
    // failing loudly would break /wrap's final report.
    process.exit(0);
  }
  const relPath = argv[idx + 1]!;
  // Guard against `--suggest-line --for-write` (flag-as-path); behave as if
  // the positional path were missing rather than emit a confusing suggestion.
  if (relPath.startsWith("-")) process.exit(0);
  const forWrite = argv.includes("--for-write");
  const line = suggestLine(process.cwd(), relPath, forWrite);
  if (line.length > 0) process.stdout.write(line + "\n");
  process.exit(0);
}
