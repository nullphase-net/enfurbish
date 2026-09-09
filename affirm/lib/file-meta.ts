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

function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
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
