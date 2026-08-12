import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "hooks", "session-start.ts");
const ROOT = join(import.meta.dir, "..");

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "pastiche-hook-test-"));
}

async function runHook(pasticheDir: string): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    env: { ...process.env, PASTICHE_DIR: pasticheDir, CLAUDE_PLUGIN_ROOT: ROOT },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return { stdout, code: await proc.exited };
}

describe("session-start hook", () => {
  test("emits empty JSON when there is no ledger", async () => {
    const { stdout, code } = await runHook(freshDir());
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
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
    expect(ctx).toContain("teuk");        // stalest is due
    expect(ctx).not.toContain("phteah");  // fresher one is not, due=1
    expect(ctx).toContain("aspiration");  // km language notes came along
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
