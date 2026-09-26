import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function getMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export type GitInfo = {
  inRepo: boolean;
  lastCommit: { author: string; date: string } | null;
  dirty: boolean;
  /** A call past the repo check failed, so a null `lastCommit` or a false `dirty`
   *  is not an answer. Unset means every call answered. */
  unknown?: true;
};

/**
 * Every git call in this plugin routes through here, so one bound covers all of
 * them — three per NEW/CHANGED file, from a SessionStart hook that must not
 * block the session. It was the last uncapped git subprocess in the stack;
 * `continuity`'s `commitsSince` (2000ms) and `gitignore` (5000ms) already had
 * theirs, and "hooks never block the session" rested on this one line.
 *
 * A timeout kills the child and leaves `status` null, which maps to -1: a code
 * git itself never exits with. Most callers treat any non-zero code as "no
 * information", which degrades the banner to showing less rather than showing
 * something wrong. `gitVisibility` is the one caller that reads 1 as a specific
 * answer, which is why a timeout must not look like 1.
 *
 * The hang path itself is untested — reproducing it needs a git that blocks,
 * which nothing here can arrange cheaply. Neither existing timeout in this repo
 * is tested either; this is a known gap, not an oversight.
 */
function git(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function getGitInfo(projectDir: string, filePath: string): GitInfo {
  const inRepo = git(projectDir, ["rev-parse", "--is-inside-work-tree"]).code === 0;
  if (!inRepo) return { inRepo: false, lastCommit: null, dirty: false };

  // Format uses %n (newline) between author and ISO date — newlines are illegal in
  // git author names, so splitting on \n is unambiguous.
  const log = git(projectDir, ["log", "-1", "--format=%an%n%aI", "--", filePath]);
  let lastCommit: GitInfo["lastCommit"] = null;
  if (log.code === 0 && log.stdout.trim().length > 0) {
    const [author, date] = log.stdout.trim().split("\n");
    if (author && date) lastCommit = { author, date };
  }

  const status = git(projectDir, ["status", "--porcelain", "--", filePath]);
  const dirty = status.code === 0 && status.stdout.trim().length > 0;

  // A failed log rendered as "untracked" and a failed status as clean.
  const unknown = log.code !== 0 || status.code !== 0;
  return { inRepo, lastCommit, dirty, ...(unknown ? { unknown: true as const } : {}) };
}

/**
 * Subjects of commits touching `filePath` after `iso`, newest first. Empty is git's
 * answer that there were none; null is no answer. They were one value until
 * `gitVisibility` began telling a tracked file's "no commits in window" apart, and
 * then a failed log for a tracked file printed that as if git had looked.
 */
export function commitsTouching(projectDir: string, filePath: string, iso: string): string[] | null {
  const r = git(projectDir, ["log", "--format=%s", `--since=${iso}`, "--", filePath]);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

export type GitVisibility = "tracked" | "untracked" | "ignored" | "no-repo" | "unknown";

/**
 * Whether git can see `filePath` at all. An empty `commitsTouching` means "no
 * commits in window" only for a tracked file; for any other it describes the
 * query, not the file (symbion 233: this repo's own CLAUDE.md is gitignored, and
 * "no commits in window" read as reassurance).
 *
 * Every answer is matched against the exit codes git documents — ls-files
 * --error-unmatch and check-ignore both exit 0 for yes and 1 for no — and "not a
 * git repository" on stderr. Anything else, a timeout included, is "unknown",
 * never the negative case.
 */
export function gitVisibility(projectDir: string, filePath: string): GitVisibility {
  const inside = git(projectDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return inside.stderr.includes("not a git repository") ? "no-repo" : "unknown";
  }
  const tracked = git(projectDir, ["ls-files", "--error-unmatch", "--", filePath]).code;
  if (tracked === 0) return "tracked";
  if (tracked !== 1) return "unknown";
  const ignored = git(projectDir, ["check-ignore", "-q", "--", filePath]).code;
  return ignored === 0 ? "ignored" : ignored === 1 ? "untracked" : "unknown";
}
