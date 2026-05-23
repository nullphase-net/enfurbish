import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { approveAll, normalizeProjectDir, saveHashes, sha256OfFile } from "../lib/affirm";

function mkDir(prefix: string): string {
  return normalizeProjectDir(mkdtempSync(join(tmpdir(), prefix)));
}

const SCRIPT = join(import.meta.dir, "..", "hooks", "session-start.ts");

function runHook(env: Record<string, string>, hashPath?: string) {
  return spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      ...(hashPath ? { HOME: hashPath } : {}),
    },
  });
}

test("emits {} when no instruction files exist", () => {
  const dir = mkDir("affirm-hook-");
  const res = runHook({ CLAUDE_PROJECT_DIR: dir });
  expect(res.status).toBe(0);
  expect(JSON.parse(res.stdout)).toEqual({});
});

test("banner marks all files NEW when hash store is empty", () => {
  // Use a temp HOME to isolate the hash store
  const home = mkDir("affirm-home-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const dir = mkDir("affirm-proj-");
  writeFileSync(join(dir, "CLAUDE.md"), "v1");

  const res = spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: home },
  });
  const json = JSON.parse(res.stdout);
  expect(json.systemMessage).toContain("Affirm: instruction files in this project:");
  expect(json.systemMessage).toContain("✦ CLAUDE.md  [NEW — unaffirmed]");
  expect(json.systemMessage).toContain("Review unaffirmed files");
  expect(json.systemMessage).toContain("/affirm");
});

test("banner marks affirmed files with ✓ and omits warning", () => {
  const home = mkDir("affirm-home-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const dir = mkDir("affirm-proj-");
  writeFileSync(join(dir, "CLAUDE.md"), "v1");

  // Pre-approve into this temp HOME's hash file
  const hashPath = join(home, ".claude", "affirm-hashes.json");
  saveHashes({ [join(dir, "CLAUDE.md")]: sha256OfFile(join(dir, "CLAUDE.md")) }, hashPath);

  const res = spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: home },
  });
  const json = JSON.parse(res.stdout);
  expect(json.systemMessage).toContain("✓ CLAUDE.md");
  expect(json.systemMessage).not.toContain("NEW");
  expect(json.systemMessage).not.toContain("CHANGED");
  expect(json.systemMessage).not.toContain("Review unaffirmed");
});

test("banner marks tampered files CHANGED and warns", () => {
  const home = mkDir("affirm-home-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const dir = mkDir("affirm-proj-");
  writeFileSync(join(dir, "CLAUDE.md"), "v1");

  const hashPath = join(home, ".claude", "affirm-hashes.json");
  saveHashes({ [join(dir, "CLAUDE.md")]: sha256OfFile(join(dir, "CLAUDE.md")) }, hashPath);

  // Tamper after pre-approval
  writeFileSync(join(dir, "CLAUDE.md"), "v2-malicious");

  const res = spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: home },
  });
  const json = JSON.parse(res.stdout);
  expect(json.systemMessage).toContain("✧ CLAUDE.md  [CHANGED — unaffirmed]");
  expect(json.systemMessage).toContain("Review unaffirmed");
});

test("CLAUDE_PROJECT_DIR overrides process.cwd()", () => {
  const home = mkDir("affirm-home-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const projectDir = mkDir("affirm-proj-");
  const launchDir = mkDir("affirm-launch-");
  writeFileSync(join(projectDir, "CLAUDE.md"), "rules");

  const res = spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    cwd: launchDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, HOME: home },
  });
  const json = JSON.parse(res.stdout);
  expect(json.systemMessage).toContain("✦ CLAUDE.md");
});

test("emits {} when CLAUDE_PROJECT_DIR points to a missing dir", () => {
  const res = runHook({ CLAUDE_PROJECT_DIR: "/no/such/path/exists" });
  expect(res.status).toBe(0);
  expect(res.stdout.trim()).toBe("{}");
});

test("banner is prefixed with 'Affirm:'", () => {
  const home = mkDir("affirm-home-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const dir = mkDir("affirm-proj-");
  writeFileSync(join(dir, "CLAUDE.md"), "v1");

  const res = spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: home },
  });
  const json = JSON.parse(res.stdout);
  expect(json.systemMessage.startsWith("Affirm:")).toBe(true);
});
