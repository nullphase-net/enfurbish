// continuity/tests/helpers/git.ts
import { spawnSync } from "node:child_process";

export type GitFixture = {
  /** Restore process.env values that gitInitClean overrode. Call in `finally`. */
  cleanup: () => void;
};

/**
 * Initialize a fresh git repo at `dir` with HOME/XDG_CONFIG_HOME/GIT_CONFIG_NOSYSTEM
 * overridden so the developer's global git config (init.templateDir, core.excludesFile,
 * global hooks) cannot leak into the fixture.
 *
 * The env overrides are applied to `process.env` so production code under test
 * inherits them on its own git calls; `cleanup()` restores the originals.
 */
export function gitInitClean(dir: string): GitFixture {
  const orig = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  const opts = { cwd: dir };
  spawnSync("git", ["init", "-q", "-b", "main"], opts);
  spawnSync("git", ["config", "user.email", "test@example.com"], opts);
  spawnSync("git", ["config", "user.name", "Test User"], opts);
  spawnSync("git", ["config", "commit.gpgsign", "false"], opts);

  return {
    cleanup: () => {
      for (const [k, v] of Object.entries(orig) as [keyof typeof orig, string | undefined][]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
