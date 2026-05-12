import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(import.meta.dir, "..", "hooks", "session-start.ts");

function runHook(env: Record<string, string>) {
  return spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("emits empty JSON when no NEXT_SESSION.md exists anywhere", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuity-hook-"));
  const res = runHook({ CLAUDE_PROJECT_DIR: dir });
  expect(res.status).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json).toEqual({});
});

test("emits only a systemMessage when local NEXT_SESSION.md is present (no context dump)", () => {
  const dir = mkdtempSync(join(tmpdir(), "continuity-hook-"));
  writeFileSync(join(dir, "NEXT_SESSION.md"), "# Next session\n\nResume the auth refactor.\n");
  const res = runHook({ CLAUDE_PROJECT_DIR: dir });
  expect(res.status).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.systemMessage).toMatch(/^Continuity: NEXT_SESSION.md present/);
  expect(json.systemMessage).toContain("/resume");
  expect(json.hookSpecificOutput).toBeUndefined();
  expect(JSON.stringify(json)).not.toContain("Resume the auth refactor.");
});

test("CLAUDE_PROJECT_DIR overrides process.cwd()", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "continuity-proj-"));
  const launchDir = mkdtempSync(join(tmpdir(), "continuity-launch-"));
  writeFileSync(join(projectDir, "NEXT_SESSION.md"), "from project dir");
  const res = spawnSync("bun", ["run", SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    cwd: launchDir,
  });
  const json = JSON.parse(res.stdout);
  expect(json.systemMessage).toContain("NEXT_SESSION.md present");
});

test("findProjectRoot walks up to nearest .git or CLAUDE.md", async () => {
  const { findProjectRoot } = await import("../hooks/session-start");
  const root = mkdtempSync(join(tmpdir(), "continuity-walk-"));
  mkdirSync(join(root, "a", "b", "c"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "marker");
  expect(findProjectRoot(join(root, "a", "b", "c"))).toBe(root);
});

test("findProjectRoot falls back to start dir when no marker found", async () => {
  const { findProjectRoot } = await import("../hooks/session-start");
  const root = mkdtempSync(join(tmpdir(), "continuity-walk-nope-"));
  expect(findProjectRoot(root)).toBe(root);
});

test("scanForNextSessions finds files up to depth 4", async () => {
  const { scanForNextSessions } = await import("../hooks/session-start");
  const root = mkdtempSync(join(tmpdir(), "continuity-scan-"));
  mkdirSync(join(root, "a", "b"), { recursive: true });
  mkdirSync(join(root, "a", "b", "c", "d", "e"), { recursive: true });
  writeFileSync(join(root, "NEXT_SESSION.md"), "root");
  writeFileSync(join(root, "a", "NEXT_SESSION.md"), "depth1");
  writeFileSync(join(root, "a", "b", "NEXT_SESSION.md"), "depth2");
  writeFileSync(join(root, "a", "b", "c", "d", "e", "NEXT_SESSION.md"), "depth5");
  const files = scanForNextSessions(root).map((f: any) => f.path).sort();
  expect(files).toEqual([
    join(root, "NEXT_SESSION.md"),
    join(root, "a", "NEXT_SESSION.md"),
    join(root, "a", "b", "NEXT_SESSION.md"),
  ]);
});

test("scanForNextSessions skips ignore dirs", async () => {
  const { scanForNextSessions } = await import("../hooks/session-start");
  const root = mkdtempSync(join(tmpdir(), "continuity-scan-ign-"));
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "node_modules", "pkg", "NEXT_SESSION.md"), "ignore-me");
  writeFileSync(join(root, ".git", "NEXT_SESSION.md"), "ignore-me");
  writeFileSync(join(root, "src", "NEXT_SESSION.md"), "keep-me");
  const files = scanForNextSessions(root).map((f: any) => f.path);
  expect(files).toEqual([join(root, "src", "NEXT_SESSION.md")]);
});

test("scanForNextSessions does not follow symlinks", async () => {
  const { scanForNextSessions } = await import("../hooks/session-start");
  const root = mkdtempSync(join(tmpdir(), "continuity-scan-sym-"));
  const other = mkdtempSync(join(tmpdir(), "continuity-scan-other-"));
  writeFileSync(join(other, "NEXT_SESSION.md"), "via-symlink");
  symlinkSync(other, join(root, "linked"));
  writeFileSync(join(root, "NEXT_SESSION.md"), "real");
  const files = scanForNextSessions(root).map((f: any) => f.path);
  expect(files).toEqual([join(root, "NEXT_SESSION.md")]);
});

test("banner lists siblings alongside local handoff", () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-sib-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "frontend"));
  mkdirSync(join(root, "api"));
  writeFileSync(join(root, "NEXT_SESSION.md"), "root next session");
  writeFileSync(join(root, "frontend", "NEXT_SESSION.md"), "fe");
  writeFileSync(join(root, "api", "NEXT_SESSION.md"), "api");

  const res = runHook({ CLAUDE_PROJECT_DIR: root });
  const json = JSON.parse(res.stdout);
  const msg: string = json.systemMessage;

  expect(msg).toContain("NEXT_SESSION.md present");
  expect(msg).toContain("2 sibling handoffs also found");
  expect(msg).toContain("frontend/NEXT_SESSION.md");
  expect(msg).toContain("api/NEXT_SESSION.md");
  expect(msg).toMatch(/modified \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});

test("heads-up mode: no local file, siblings listed in banner", () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-headsup-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "frontend"));
  writeFileSync(join(root, "frontend", "NEXT_SESSION.md"), "fe work");

  const res = runHook({ CLAUDE_PROJECT_DIR: root });
  const json = JSON.parse(res.stdout);
  const msg: string = json.systemMessage;

  expect(msg).toContain("no NEXT_SESSION.md in this cwd");
  expect(msg).toContain("1 handoff in sibling dirs");
  expect(msg).toContain("frontend/NEXT_SESSION.md");
  expect(msg).not.toContain("fe work");
});

test("emits empty JSON when CLAUDE_PROJECT_DIR points to a missing directory", () => {
  const res = runHook({ CLAUDE_PROJECT_DIR: "/no/such/path/exists" });
  expect(res.status).toBe(0);
  expect(res.stdout.trim()).toBe("{}");
});
