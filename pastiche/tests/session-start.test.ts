import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DORMANT_AFTER } from "../lib/pastiche";
import { supersededNote } from "../hooks/session-start";

const HOOK = join(import.meta.dir, "..", "hooks", "session-start.ts");
const ROOT = join(import.meta.dir, "..");

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "pastiche-hook-test-"));
}

async function runHook(
  pasticheDir: string,
  sessionId?: string,
): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    env: { ...process.env, PASTICHE_DIR: pasticheDir, CLAUDE_PLUGIN_ROOT: ROOT },
    // Claude Code hands every hook a JSON payload on stdin; a manual run has none.
    stdin: sessionId === undefined ? "ignore" : new Blob([JSON.stringify({ session_id: sessionId })]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return { stdout, code: await proc.exited };
}


// A session running a stale copy of the plugin whose checkout it is working in.
function manifests(name: string, running: string, here: string) {
  const base = mkdtempSync(join(tmpdir(), "superseded-"));
  const pluginRoot = join(base, "plugins", "cache", "mkt", name, running);
  const projectDir = join(base, "checkout");
  for (const [dir, version] of [[pluginRoot, running], [join(projectDir, name), here]]) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version }));
  }
  return { pluginRoot, projectDir };
}

test("supersededNote names both versions and the way to ship when they differ", () => {
  const { pluginRoot, projectDir } = manifests("pastiche", "0.1.0", "0.2.0");
  const line = "pastiche 0.1.0 is running, but this checkout has 0.2.0. It reaches sessions only through the " +
    "marketplace: push, then `claude plugin update pastiche@mkt`, then /reload-plugins.";
  expect(supersededNote(pluginRoot, projectDir)).toBe(line);
  expect(supersededNote(pluginRoot, join(projectDir, "pastiche"))).toBe(line); // cwd = the plugin's own dir
});

test("supersededNote is empty when the versions match or the cwd is not the checkout", () => {
  const same = manifests("pastiche", "0.1.0", "0.1.0");
  expect(supersededNote(same.pluginRoot, same.projectDir)).toBe("");
  const other = manifests("pastiche", "0.1.0", "0.2.0");
  expect(supersededNote(other.pluginRoot, mkdtempSync(join(tmpdir(), "elsewhere-")))).toBe("");
});

test("hook emits the note on both channels even with no languages configured", async () => {
  const { pluginRoot, projectDir } = manifests("pastiche", "0.1.0", "0.2.0");
  const proc = Bun.spawn(["bun", "run", HOOK], {
    env: { ...process.env, PASTICHE_DIR: freshDir(), CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: projectDir },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const json = JSON.parse(await new Response(proc.stdout).text());
  expect(json.systemMessage).toContain("pastiche 0.1.0 is running");
  expect(json.hookSpecificOutput.additionalContext).toContain("pastiche 0.1.0 is running");
});

describe("session-start hook", () => {
  // The gate is configured languages, not the ledger file. Nothing to teach
  // means silence; something to teach but nowhere to write it yet does not.
  test("emits empty JSON when no languages are configured", async () => {
    const { stdout, code } = await runHook(freshDir());
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("still teaches when languages are configured but the ledger is missing", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      ledger: join(dir, "nope", "ledger.md"),
      languages: [{ code: "km", name: "Khmer", domains: "everyday" }],
    }));

    const { stdout, code } = await runHook(dir);
    expect(code).toBe(0);
    const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("nothing due yet");
    expect(ctx).toContain("Introduce up to 2 new term");
  });

  test("injects additionalContext with due items when a ledger exists", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      ledger: join(dir, "ledger.md"),
      due: 1,
      languages: [{ code: "km", name: "Khmer", domains: "everyday" }],
    }));
    writeFileSync(join(dir, "ledger.md"),
      "- km: ទឹក (teuk) — water | 2026-01-01 | seen: 2026-01-01\n" +
      "- km: ផ្ទះ (phteah) — house | 2026-01-01 | seen: 2026-06-01\n");

    const { stdout, code } = await runHook(dir);
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ctx = out.hookSpecificOutput.additionalContext;
    const due = ctx.split("Due for re-surfacing")[1];
    expect(due).toContain("teuk");        // stalest is due
    expect(due).not.toContain("phteah");  // fresher one is not, due=1
    expect(ctx).toContain("aspiration");  // km language notes came along
  });

  // 7c2, end to end: the count lives in a sidecar the hook owns, keyed by session.
  function twoTerms(): string {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      ledger: join(dir, "ledger.md"),
      due: 1,
      languages: [{ code: "km", name: "Khmer", domains: "everyday" }],
    }));
    writeFileSync(join(dir, "ledger.md"),
      "- km: ទឹក (teuk) — water | 2026-01-01 | seen: 2026-01-01\n" +
      "- km: ផ្ទះ (phteah) — house | 2026-01-01 | seen: 2026-06-01\n");
    return dir;
  }
  // The due list only: the prompt's fixed script example is "ទឹក (teuk) — water",
  // so a match against the whole context passes whether or not teuk is due.
  const dueOf = (stdout: string): string =>
    JSON.parse(stdout).hookSpecificOutput.additionalContext.split("Due for re-surfacing")[1];

  test(`rotates a due item out after ${DORMANT_AFTER} sessions that did not use it`, async () => {
    const dir = twoTerms();
    const ids = Array.from({ length: DORMANT_AFTER }, (_, i) => `s${i}`);
    // The first session fires twice, as a compaction re-fire does; it counts once.
    for (const id of [ids[0], ...ids]) {
      const { stdout, code } = await runHook(dir, id);
      expect(code).toBe(0);
      expect(dueOf(stdout)).toContain("teuk");
    }
    const due = dueOf((await runHook(dir, "next")).stdout);
    expect(due).toContain("phteah");
    expect(due).not.toContain("teuk");
  });

  test("a run with no session id counts nothing", async () => {
    const dir = twoTerms();
    for (let i = 0; i <= DORMANT_AFTER; i++) {
      expect(dueOf((await runHook(dir)).stdout)).toContain("teuk");
    }
  });

  test("a corrupt sidecar still teaches, and the next session repairs it", async () => {
    const dir = twoTerms();
    writeFileSync(join(dir, "surfaced.json"), "{{{ not json");
    const { stdout, code } = await runHook(dir, "s0");
    expect(code).toBe(0);
    expect(dueOf(stdout)).toContain("teuk");
    expect(() => JSON.parse(readFileSync(join(dir, "surfaced.json"), "utf8"))).not.toThrow();
  });

  // The contract that matters: a broken hook must cost the user a plain session,
  // never a blocked one.
  test("a malformed config still exits 0 with valid JSON", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "config.json"), "{{{ not json at all");
    const { stdout, code } = await runHook(dir);
    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});
