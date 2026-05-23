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
