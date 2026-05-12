import { test, expect } from "bun:test";
import { encodeCwd, findTranscript, parseTranscript } from "../lib/scan";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("encodeCwd replaces / with - including leading slash", () => {
  expect(encodeCwd("/Volumes/chonk/projects/claude"))
    .toBe("-Volumes-chonk-projects-claude");
});

test("encodeCwd handles a simple path", () => {
  expect(encodeCwd("/x")).toBe("-x");
});

test("findTranscript returns the file in the encoded-cwd dir whose first event matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "wrap-scan-"));
  const cwd = "/Volumes/chonk/projects/claude";
  const proj = join(root, "-Volumes-chonk-projects-claude");
  mkdirSync(proj, { recursive: true });

  const f1 = join(proj, "11111111-0000-0000-0000-000000000000.jsonl");
  writeFileSync(f1, JSON.stringify({
    type: "user", cwd: "/Volumes/chonk/projects/other",
    timestamp: "2026-05-10T20:00:00.000Z",
    sessionId: "11111111-0000-0000-0000-000000000000",
    message: { role: "user", content: [{ type: "text", text: "x" }] },
  }) + "\n");

  const f2 = join(proj, "22222222-0000-0000-0000-000000000000.jsonl");
  writeFileSync(f2, JSON.stringify({
    type: "user", cwd,
    timestamp: "2026-05-10T19:00:00.000Z",
    sessionId: "22222222-0000-0000-0000-000000000000",
    message: { role: "user", content: [{ type: "text", text: "y" }] },
  }) + "\n");

  const result = await findTranscript({ cwd, projectsRoot: root });
  expect(result.path).toBe(f2);
  expect(result.sessionId).toBe("22222222-0000-0000-0000-000000000000");
});

test("findTranscript picks most recent by last-event timestamp when multiple match", async () => {
  const root = mkdtempSync(join(tmpdir(), "wrap-scan-"));
  const cwd = "/Volumes/chonk/projects/claude";
  const proj = join(root, "-Volumes-chonk-projects-claude");
  mkdirSync(proj, { recursive: true });

  const older = join(proj, "33333333-0000-0000-0000-000000000000.jsonl");
  writeFileSync(older,
    JSON.stringify({ type: "user", cwd, timestamp: "2026-05-10T10:00:00.000Z", sessionId: "33333333-0000-0000-0000-000000000000", message: { role: "user", content: [] } }) + "\n" +
    JSON.stringify({ type: "user", cwd, timestamp: "2026-05-10T10:30:00.000Z", sessionId: "33333333-0000-0000-0000-000000000000", message: { role: "user", content: [] } }) + "\n"
  );

  const newer = join(proj, "44444444-0000-0000-0000-000000000000.jsonl");
  writeFileSync(newer,
    JSON.stringify({ type: "user", cwd, timestamp: "2026-05-10T11:00:00.000Z", sessionId: "44444444-0000-0000-0000-000000000000", message: { role: "user", content: [] } }) + "\n" +
    JSON.stringify({ type: "user", cwd, timestamp: "2026-05-10T15:00:00.000Z", sessionId: "44444444-0000-0000-0000-000000000000", message: { role: "user", content: [] } }) + "\n"
  );

  const result = await findTranscript({ cwd, projectsRoot: root });
  expect(result.path).toBe(newer);
});

test("findTranscript falls back to global scan when encoded-cwd dir missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "wrap-scan-"));
  const cwd = "/Volumes/chonk/projects/claude";
  const otherProj = join(root, "-some-other-encoding");
  mkdirSync(otherProj, { recursive: true });
  const f = join(otherProj, "55555555-0000-0000-0000-000000000000.jsonl");
  writeFileSync(f, JSON.stringify({
    type: "user", cwd,
    timestamp: "2026-05-10T22:00:00.000Z",
    sessionId: "55555555-0000-0000-0000-000000000000",
    message: { role: "user", content: [] },
  }) + "\n");

  const result = await findTranscript({ cwd, projectsRoot: root });
  expect(result.path).toBe(f);
});

test("findTranscript throws not-found when nothing matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "wrap-scan-"));
  await expect(findTranscript({ cwd: "/no/such/cwd", projectsRoot: root }))
    .rejects.toThrow(/transcript not found/);
});

const FIXTURE = join(import.meta.dir, "..", "fixtures", "happy-session.jsonl");

test("parseTranscript returns session id and timestamps", async () => {
  const r = await parseTranscript(FIXTURE);
  expect(r.session_id).toBe("abc12345-1234-5678-90ab-cdef00000001");
  expect(r.session_id_short).toBe("abc12345");
  expect(r.session_start).toBe("2026-05-10T17:00:00.000Z");
  expect(r.session_end).toBe("2026-05-10T17:00:09.000Z");
  expect(r.duration_ms).toBe(9000);
});

test("parseTranscript counts non-MCP tools separately from MCP", async () => {
  const r = await parseTranscript(FIXTURE);
  expect(r.tools.Read?.calls).toBe(1);
  expect(r.tools.Bash?.calls).toBe(1);
  expect(r.tools.Bash?.errors).toBe(1);
  expect(r.tools.Edit?.calls).toBe(1);
  expect(r.tools.Skill?.calls).toBe(1);
  expect(r.tools["mcp__shodh-memory__remember"]).toBeUndefined();
  expect(r.mcp["mcp__shodh-memory__remember"]?.calls).toBe(1);
});

test("parseTranscript records hooks", async () => {
  const r = await parseTranscript(FIXTURE);
  expect(r.hooks.SessionStart?.fired).toBe(1);
  expect(r.hooks.Stop?.fired).toBe(1);
});

test("parseTranscript captures skills_invoked", async () => {
  const r = await parseTranscript(FIXTURE);
  expect(r.skills_invoked).toContain("superpowers:brainstorming");
});

test("parseTranscript records files_edited and files_read_count", async () => {
  const r = await parseTranscript(FIXTURE);
  expect(r.files_edited).toContain("/repo/a.ts");
  expect(r.files_read_count).toBe(1);
});

test("parseTranscript counts user vs model turns", async () => {
  const r = await parseTranscript(FIXTURE);
  expect(r.turn_count.user).toBeGreaterThan(0);
  expect(r.turn_count.model).toBeGreaterThan(0);
});

test("parseTranscript on truncated input returns degraded result", async () => {
  const path = join(import.meta.dir, "..", "fixtures", "truncated-session.jsonl");
  const r = await parseTranscript(path);
  expect(r.degraded).toBe(true);
  expect(typeof r.reason).toBe("string"); // no cast needed — degraded/reason are typed on ScanOk
});

test("parseTranscript caps files_edited at 50, prefers most-recent", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wrap-cap-"));
  const f = join(tmp, "x.jsonl");
  const lines: string[] = [];
  for (let i = 0; i < 60; i++) {
    const ss = i < 10 ? `0${i}` : `${i}`;
    lines.push(JSON.stringify({
      type: "assistant",
      timestamp: `2026-05-10T17:00:${ss}.000Z`,
      cwd: "/x",
      sessionId: "00000000-0000-0000-0000-000000000000",
      message: { role: "assistant", content: [{ type: "tool_use", id: `tu${i}`, name: "Edit", input: { file_path: `/file${i}.ts` } }] },
    }));
  }
  writeFileSync(f, lines.join("\n") + "\n");
  const r = await parseTranscript(f);
  expect(r.files_edited.length).toBe(50);
  expect(r.files_edited).toContain("/file59.ts");
  expect(r.files_edited).not.toContain("/file0.ts");
});

import { spawnSync } from "node:child_process";

test("CLI emits valid JSON for happy path", () => {
  const fixturesRoot = mkdtempSync(join(tmpdir(), "wrap-cli-"));
  const proj = join(fixturesRoot, "-Volumes-chonk-projects-claude");
  mkdirSync(proj, { recursive: true });
  const fixturePath = join(import.meta.dir, "..", "fixtures", "happy-session.jsonl");
  const target = join(proj, "abc12345-1234-5678-90ab-cdef00000001.jsonl");
  writeFileSync(target, readFileSync(fixturePath, "utf8"));

  const res = spawnSync("bun", [
    "run", join(import.meta.dir, "..", "lib", "scan.ts"),
    "--cwd", "/Volumes/chonk/projects/claude",
    "--projects-root", fixturesRoot,
  ], { encoding: "utf8" });

  expect(res.status).toBe(0);
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(true);
  expect(json.session_id_short).toBe("abc12345");
  expect(json.tools.Read.calls).toBe(1);
});

test("CLI emits degraded JSON when transcript not found", () => {
  const empty = mkdtempSync(join(tmpdir(), "wrap-empty-"));
  const res = spawnSync("bun", [
    "run", join(import.meta.dir, "..", "lib", "scan.ts"),
    "--cwd", "/no/such/cwd",
    "--projects-root", empty,
  ], { encoding: "utf8" });

  expect(res.status).toBe(0); // still exits 0; degraded is signaled in JSON
  const json = JSON.parse(res.stdout);
  expect(json.ok).toBe(false);
  expect(json.degraded).toBe(true);
  expect(typeof json.reason).toBe("string");
});
