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
};

/**
 * Every git call in this plugin routes through here, so one bound covers all of
 * them — three per NEW/CHANGED file, from a SessionStart hook that must not
 * block the session. It was the last uncapped git subprocess in the stack;
 * `continuity`'s `commitsSince` (2000ms) and `gitignore` (5000ms) already had
 * theirs, and "hooks never block the session" rested on this one line.
 *
 * A timeout kills the child and leaves `status` null, so it falls through the
 * same `?? 1` branch as a genuine git failure. That conflation is deliberate
 * here and only here: every caller treats a non-zero code as "no information",
 * which degrades the banner to showing less rather than showing something
 * wrong. Do not add a caller that reads code 1 as a specific cause.
 *
 * The hang path itself is untested — reproducing it needs a git that blocks,
 * which nothing here can arrange cheaply. Neither existing timeout in this repo
 * is tested either; this is a known gap, not an oversight.
 */
function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
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

  return { inRepo, lastCommit, dirty };
}

/**
 * Subjects of commits touching `filePath` after `iso`, newest first.
 *
 * Empty means either no commits in the window or not a repo — for the caller's
 * purpose (describing a change the user already made) both read the same, and the
 * file's own mtime is what established that a change happened at all.
 */
export function commitsTouching(projectDir: string, filePath: string, iso: string): string[] {
  const r = git(projectDir, ["log", "--format=%s", `--since=${iso}`, "--", filePath]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}
