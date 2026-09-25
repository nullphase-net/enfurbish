import { test, expect } from "bun:test";
import { FILES_CHANGED_CAP, encodeCwd, findTranscript, gitChangedSince, parseTranscript } from "../lib/scan";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, realpathSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gitInitClean } from "./helpers/git";

test("encodeCwd replaces / with - including leading slash", () => {
  expect(encodeCwd("/Volumes/data/projects/claude"))
    .toBe("-Volumes-data-projects-claude");
});

test("encodeCwd handles a simple path", () => {
  expect(encodeCwd("/x")).toBe("-x");
});

test("findTranscript returns the file in the encoded-cwd dir whose first event matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "wrap-scan-"));
  const cwd = "/Volumes/data/projects/claude";
  const proj = join(root, "-Volumes-data-projects-claude");
  mkdirSync(proj, { recursive: true });

  const f1 = join(proj, "11111111-0000-0000-0000-000000000000.jsonl");
  writeFileSync(f1, JSON.stringify({
    type: "user", cwd: "/Volumes/data/projects/other",
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
  const cwd = "/Volumes/data/projects/claude";
  const proj = join(root, "-Volumes-data-projects-claude");
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
  const cwd = "/Volumes/data/projects/claude";
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

test("findTranscript resolves cwd through a symlink to its canonical path", async () => {
  // Models the field-report case: $(pwd) returns /Users/me/projects/X (symlink)
  // but the transcript dir is encoded from /Volumes/data/projects/X (canonical).
  const root = mkdtempSync(join(tmpdir(), "wrap-scan-sl-"));
  const workspace = mkdtempSync(join(tmpdir(), "wrap-ws-"));
  const realPath = join(workspace, "real");
  mkdirSync(realPath, { recursive: true });
  // Resolve through any /private prefix macOS adds in /var/folders.
  const canonicalReal = realpathSync(realPath);
  const symlinkPath = join(workspace, "link");
  symlinkSync(canonicalReal, symlinkPath);

  const proj = join(root, encodeCwd(canonicalReal));
  mkdirSync(proj, { recursive: true });
  const transcript = join(proj, "66666666-0000-0000-0000-000000000000.jsonl");
  writeFileSync(transcript, JSON.stringify({
    type: "user", cwd: canonicalReal,
    timestamp: "2026-05-22T00:00:00.000Z",
    sessionId: "66666666-0000-0000-0000-000000000000",
    message: { role: "user", content: [] },
  }) + "\n");

  const result = await findTranscript({ cwd: symlinkPath, projectsRoot: root });
  expect(result.path).toBe(transcript);
  expect(result.sessionId).toBe("66666666-0000-0000-0000-000000000000");
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

test("parseTranscript reports compaction_count = 0 when no compactions", async () => {
  const r = await parseTranscript(FIXTURE);
  expect(r.compaction_count).toBe(0);
});

test("parseTranscript counts compact_boundary system events", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "wrap-compact-"));
  const f = join(tmp, "x.jsonl");
  writeFileSync(f, [
    JSON.stringify({ type: "user", cwd: "/x", timestamp: "2026-05-10T10:00:00.000Z", sessionId: "sid", message: { role: "user", content: [{ type: "text", text: "a" }] } }),
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-05-10T10:30:00.000Z", sessionId: "sid", content: "Conversation compacted" }),
    JSON.stringify({ type: "user", cwd: "/x", timestamp: "2026-05-10T11:00:00.000Z", sessionId: "sid", message: { role: "user", content: [{ type: "text", text: "b" }] } }),
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-05-10T12:00:00.000Z", sessionId: "sid", content: "Conversation compacted" }),
  ].join("\n") + "\n");
  const r = await parseTranscript(f);
  expect(r.compaction_count).toBe(2);
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
  const proj = join(fixturesRoot, "-Volumes-data-projects-claude");
  mkdirSync(proj, { recursive: true });
  const fixturePath = join(import.meta.dir, "..", "fixtures", "happy-session.jsonl");
  const target = join(proj, "abc12345-1234-5678-90ab-cdef00000001.jsonl");
  writeFileSync(target, readFileSync(fixturePath, "utf8"));

  const res = spawnSync("bun", [
    "run", join(import.meta.dir, "..", "lib", "scan.ts"),
    "--cwd", "/Volumes/data/projects/claude",
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

// --- turn_count.user / skills_invoked: the shapes a real transcript uses ---
// Six wraps logged `turn_count.user` at 1-4 against 8-13 real prompts. Cause:
// a typed prompt arrives as bare-string content, and the parser only looked at
// array content. These pin each shape to its intended count.

function userRec(content: unknown) {
  return JSON.stringify({
    type: "user", cwd: "/repo", timestamp: "2026-08-18T00:00:00.000Z",
    sessionId: "77777777-0000-0000-0000-000000000000",
    message: { role: "user", content },
  });
}

function writeSession(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "wrap-turns-"));
  const path = join(dir, "77777777-0000-0000-0000-000000000000.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

test("parseTranscript counts bare-string user prompts", async () => {
  const r = await parseTranscript(writeSession([
    userRec("please take a look at the three modules on the bus"),
    userRec("add the setTimeOut and the gyro bias fix"),
    userRec([{ type: "text", text: "and this one, pasted alongside an image" }]),
  ]));
  expect(r.turn_count.user).toBe(3);
});

test("parseTranscript excludes synthetic user records from the turn count", async () => {
  const r = await parseTranscript(writeSession([
    userRec("one real prompt"),
    userRec("<task-notification>\n<task-id>bz9ad1gqc</task-id>\n<summary>Monitor event</summary>"),
    userRec("<local-command-caveat>Caveat: the messages below were generated by the user"),
    userRec("<local-command-stdout>ok</local-command-stdout>"),
    userRec("<bash-stdout>ok</bash-stdout>"),
    userRec("<system-reminder>remember the thing</system-reminder>"),
    userRec([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
    userRec(""),
  ]));
  expect(r.turn_count.user).toBe(1);
});

test("parseTranscript counts slash commands as turns and records them as skills", async () => {
  const r = await parseTranscript(writeSession([
    userRec("<command-message>continuity:wrap</command-message>\n<command-name>/continuity:wrap</command-name>\n<command-args></command-args>"),
    userRec("<command-name>/ponytail</command-name>"),
  ]));
  expect(r.turn_count.user).toBe(2);
  expect(r.skills_invoked.sort()).toEqual(["continuity:wrap", "ponytail"]);
});

// symbion c0b: session 7c452ae9's second wrap read 28 user turns against 13 typed
// prompts + 11 slash commands. Parsed from its records: 3 `[Request interrupted by
// user]` and 1 relayed agent message (`isMeta`). A survey of all 426 local transcripts
// found 451 counted records flagged `isMeta` across 35 prefixes, every one synthetic:
// relayed agent messages, /loop re-fires of a stored prompt, skill bodies and
// re-invocations, image metadata, stop-hook feedback. One case per shape, because a
// /loop re-fire is plain text and only the flag tells it from a prompt.
function metaRec(content: unknown, flags: object) {
  return JSON.stringify({ ...JSON.parse(userRec(content)), ...flags });
}

test("parseTranscript does not count records Claude Code synthesises, by flag or by shape", async () => {
  const r = await parseTranscript(writeSession([
    userRec("one real prompt"),
    metaRec("Another Claude session sent a message:\n<agent-message from=\"a1\">done</agent-message>", { isMeta: true }),
    metaRec("monitor things and ensure they are working as intended", { isMeta: true }),
    metaRec("(Re-invocation of /affirm:affirm — the skill instructions were previously loaded)", { isMeta: true }),
    userRec([{ type: "text", text: "[Request interrupted by user]" }]),
    userRec([{ type: "text", text: "[Request interrupted by user for tool use]" }]),
    metaRec("This session is being continued from a previous conversation that ran out of context.",
      { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  ]));
  expect(r.turn_count.user).toBe(1);
});

// The other direction: prompts that open with a bracket or a tag are still prompts.
test("parseTranscript still counts a prompt that opens with an image or a ! command", async () => {
  const r = await parseTranscript(writeSession([
    userRec([{ type: "text", text: "[Image #1] what is wrong with this chart?" }]),
    userRec("<bash-input>git status</bash-input>"),
  ]));
  expect(r.turn_count.user).toBe(2);
});

// symbion d77 filed "a compaction during the wrap suppresses the turn-count caveat".
// The caveat's premise was wrong: a compaction does not truncate the jsonl. Both
// compacted transcripts on this machine (Claude Code 2.1.268 and 2.1.274) keep every
// pre-compaction record in the same file — one has 12 user turns before
// its boundary, 3 after — so the count covers the whole session either way.
test("parseTranscript counts turns on both sides of a compaction", async () => {
  const r = await parseTranscript(writeSession([
    userRec("before the compaction"),
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-08-18T00:30:00.000Z",
      sessionId: "77777777-0000-0000-0000-000000000000", content: "Conversation compacted" }),
    metaRec("This session is being continued from a previous conversation that ran out of context.",
      { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    userRec("after the compaction"),
  ]));
  expect(r.compaction_count).toBe(1);
  expect(r.turn_count.user).toBe(2);
});

test("parseTranscript still credits tool errors back from tool_result records", async () => {
  const r = await parseTranscript(writeSession([
    JSON.stringify({
      type: "assistant", cwd: "/repo", timestamp: "2026-08-18T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    }),
    userRec([{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }]),
  ]));
  expect(r.tools.Bash?.errors).toBe(1);
  expect(r.turn_count.user).toBe(0);
});

// The 2026-08-18 wrap counted 10 user turns against 7 real prompts and blamed
// background-task notifications; all three of the excess were skill bodies. One
// `/next` reaches the transcript as two user records — the command, then the
// SKILL.md that loading it injected.
test("parseTranscript counts a slash command once, not twice with its skill body", async () => {
  const r = await parseTranscript(writeSession([
    userRec("<command-message>continuity:next</command-message>\n<command-name>/continuity:next</command-name>"),
    userRec([{ type: "text", text: "Base directory for this skill: /Users/x/.claude/plugins/cache/enfurbish/continuity/0.6.0/skills/next\n\n# `/next` — manual NEXT_SESSION read\n\nUse when the user wants to pick up where the last session left off." }]),
    userRec("work it as you like until you're satisfied"),
  ]));
  expect(r.turn_count.user).toBe(2);
  expect(r.skills_invoked).toContain("continuity:next");
});

// Auto mode routes every write through Bash, so `files_edited` came back empty
// after ~15 writes on 2026-08-18. Empty-because-nothing-happened and
// empty-because-invisible are different claims; only one of them is safe to
// narrate in a retro.
test("parseTranscript flags files_edited as blind when it is empty and Bash ran", async () => {
  const bash = (id: string) => JSON.stringify({
    type: "assistant", cwd: "/repo", timestamp: "2026-08-18T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] },
  });
  const r = await parseTranscript(writeSession([userRec("do it"), bash("t1")]));
  expect(r.files_edited).toEqual([]);
  expect(r.files_edited_blind).toBe(true);
});

test("files_edited_blind is absent when the field is informative", async () => {
  const edit = JSON.stringify({
    type: "assistant", cwd: "/repo", timestamp: "2026-08-18T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/repo/a.ts" } }] },
  });
  const r = await parseTranscript(writeSession([userRec("do it"), edit]));
  expect(r.files_edited).toEqual(["/repo/a.ts"]);
  expect(r.files_edited_blind).toBeUndefined();
});

// symbion 092: one Edit beside a heredoc write gave a populated files_edited that read
// as the full list; `blind` only fired when the list was empty. `repoAt` returns the
// un-normalized tmpdir path (/var/…) while git reports /private/var/…, so these also
// cover a files_edited path spelled through a symlink.
function mixedSession(root: string, edited: string[]): string {
  const rec = (extra: object) => JSON.stringify({
    cwd: root, timestamp: "2026-08-18T18:30:00-05:00",
    sessionId: "77777777-0000-0000-0000-000000000000", ...extra,
  });
  return writeSession([
    rec({ type: "user", message: { role: "user", content: "go" } }),
    ...edited.map((file_path, i) => rec({ type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: `e${i}`, name: "Write", input: { file_path } }] } })),
    rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }] } }),
  ]);
}

test("files_edited_blind flags a populated files_edited that git shows is incomplete", async () => {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  writeFileSync(join(root, "via-edit.txt"), "x");
  writeFileSync(join(root, "via-heredoc.txt"), "y");
  const r = await parseTranscript(mixedSession(root, [join(root, "via-edit.txt")]));
  expect(r.files_edited).toHaveLength(1);
  expect(r.files_edited_blind).toBe(true);
});

test("files_edited_blind stays absent when files_edited covers everything git saw", async () => {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  writeFileSync(join(root, "a.txt"), "x");
  // A Write into a new directory: git collapses it to `newdir/`, which a.txt's
  // sibling in files_edited covers.
  mkdirSync(join(root, "newdir"));
  writeFileSync(join(root, "newdir", "b.txt"), "y");
  const r = await parseTranscript(mixedSession(root, [join(root, "a.txt"), join(root, "newdir", "b.txt")]));
  expect(r.files_changed).toEqual(["a.txt", "newdir/"]);
  expect(r.files_edited_blind).toBeUndefined();
});

test("files_edited_blind is absent when the session ran no Bash at all", async () => {
  const r = await parseTranscript(writeSession([userRec("just a question")]));
  expect(r.files_edited_blind).toBeUndefined();
});

// --- gitChangedSince: the fallback for a files_edited that auto mode empties ---

function repoAt(commitIso: string): string {
  const root = mkdtempSync(join(tmpdir(), "scan-git-"));
  const fx = gitInitClean(root);
  try {
    writeFileSync(join(root, "committed.txt"), "x");
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "c"], {
      cwd: root,
      env: { ...process.env, GIT_COMMITTER_DATE: commitIso, GIT_AUTHOR_DATE: commitIso },
    });
  } finally {
    fx.cleanup();
  }
  return root;
}

test("gitChangedSince finds committed and still-dirty files both", () => {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  writeFileSync(join(root, "untracked.txt"), "y");
  writeFileSync(join(root, "committed.txt"), "modified");
  const got = gitChangedSince(root, "2026-08-18T17:00:00-05:00");
  expect(got).toEqual(["committed.txt", "untracked.txt"]);
});

// The other direction: a quiet repo must return an empty list, not a stale one.
test("gitChangedSince returns [] when nothing changed in the window", () => {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  expect(gitChangedSince(root, "2026-08-18T19:00:00-05:00")).toEqual([]);
});

// `git status` is not time-bounded: without a filter it reports every dirty file,
// including work that predates the session entirely. Measured on this repo — 19 dirty
// files, one of them a version bump a prior session left behind, reported by a session
// that never touched it.
test("gitChangedSince excludes dirty files that predate the window", () => {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  const stale = join(root, "left-over.txt");
  writeFileSync(stale, "from a prior session");
  const old = new Date("2026-08-18T12:00:00-05:00");
  utimesSync(stale, old, old);

  writeFileSync(join(root, "this-session.txt"), "now");
  const got = gitChangedSince(root, "2026-08-18T17:00:00-05:00")!;
  expect(got).toContain("this-session.txt");
  expect(got).not.toContain("left-over.txt");
});

// The other direction: the filter must not swallow a file the session really wrote.
// A deletion cannot be stat'd at all and is kept rather than dropped.
test("gitChangedSince keeps in-window edits and un-stattable deletions", () => {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  rmSync(join(root, "committed.txt"));
  writeFileSync(join(root, "fresh.txt"), "y");
  const got = gitChangedSince(root, "2026-08-18T17:00:00-05:00")!;
  expect(got).toContain("committed.txt");
  expect(got).toContain("fresh.txt");
});

// The wrap writes NEXT_SESSION.md inside the session window, so the scan's own
// artifact came back as evidence of what the session changed (the second of two
// wraps on 2026-09-10 listed it beside eleven real edits; a wrap-only session
// would list nothing else). A pointer in a subdirectory is another cwd's and is
// not this scan's to drop.
test("gitChangedSince does not report the cwd's own NEXT_SESSION.md as session work", () => {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  // sub/ must be tracked, or git collapses the untracked dir to "sub/" and hides the pointer's name
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "tracked.txt"), "x");
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "sub"], {
    cwd: root,
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-08-18T18:30:00-05:00", GIT_AUTHOR_DATE: "2026-08-18T18:30:00-05:00" },
  });
  writeFileSync(join(root, "NEXT_SESSION.md"), "# Next session — proj\n");
  writeFileSync(join(root, "real.txt"), "session work");
  writeFileSync(join(root, "sub", "NEXT_SESSION.md"), "# Next session — sub\n");
  const got = gitChangedSince(root, "2026-08-18T19:00:00-05:00");
  expect(got).toEqual(["real.txt", "sub/NEXT_SESSION.md"]);
});

// Every test above runs from the repo root. Git prints paths relative to the ROOT, and
// the filter stat'd them against the cwd, so from a subdirectory every stat missed and
// every dirty file was kept as a "deletion". The pointer exclusion keyed on a root
// path the same way, dropping another cwd's pointer and keeping this one's.
function repoWithSub(): string {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "tracked.txt"), "x");
  spawnSync("git", ["add", "-A"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "sub"], {
    cwd: root,
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-08-18T18:30:00-05:00", GIT_AUTHOR_DATE: "2026-08-18T18:30:00-05:00" },
  });
  return root;
}

test("gitChangedSince from a subdirectory still excludes dirty files that predate the window", () => {
  const root = repoWithSub();
  const stale = join(root, "left-over.txt");
  writeFileSync(stale, "from a prior session");
  const old = new Date("2026-08-18T12:00:00-05:00");
  utimesSync(stale, old, old);
  writeFileSync(join(root, "sub", "fresh.txt"), "now");
  const got = gitChangedSince(join(root, "sub"), "2026-08-18T19:00:00-05:00")!;
  expect(got).toContain("sub/fresh.txt");
  expect(got).not.toContain("left-over.txt");
});

test("gitChangedSince from a subdirectory drops its own pointer and keeps the root's", () => {
  const root = repoWithSub();
  writeFileSync(join(root, "NEXT_SESSION.md"), "# Next session — root\n");
  writeFileSync(join(root, "sub", "NEXT_SESSION.md"), "# Next session — sub\n");
  const got = gitChangedSince(join(root, "sub"), "2026-08-18T19:00:00-05:00");
  expect(got).toEqual(["NEXT_SESSION.md"]);
});

test("gitChangedSince returns null when git cannot answer, which is not []", () => {
  const bare = mkdtempSync(join(tmpdir(), "scan-nogit-"));
  expect(gitChangedSince(bare, "2026-08-18T17:00:00-05:00")).toBe(null);
  expect(gitChangedSince("", "2026-08-18T17:00:00-05:00")).toBe(null);
  expect(gitChangedSince(repoAt("2026-08-18T18:00:00-05:00"), "not a timestamp")).toBe(null);
});

// A cap that drops rows without saying how many reads exactly like a complete list,
// and this is the field /wrap now treats as its evidence. Both directions: the raw
// query stays uncapped, and the field that a wrap reads carries the count it dropped.
test("gitChangedSince returns every changed file, uncapped", () => {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  for (let i = 0; i < FILES_CHANGED_CAP + 5; i++) {
    writeFileSync(join(root, `f${String(i).padStart(3, "0")}.txt`), "x");
  }
  expect(gitChangedSince(root, "2026-08-18T17:00:00-05:00")!.length)
    .toBe(FILES_CHANGED_CAP + 5 + 1); // +1 for committed.txt
});

test("files_changed is capped and says how many it hid", async () => {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  for (let i = 0; i < FILES_CHANGED_CAP + 5; i++) {
    writeFileSync(join(root, `f${String(i).padStart(3, "0")}.txt`), "x");
  }
  const rec = (extra: object) => JSON.stringify({
    cwd: root, timestamp: "2026-08-18T18:30:00-05:00",
    sessionId: "77777777-0000-0000-0000-000000000000", ...extra,
  });
  const r = await parseTranscript(writeSession([
    rec({ type: "user", message: { role: "user", content: "go" } }),
    rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
  ]));
  expect(r.files_changed).toHaveLength(FILES_CHANGED_CAP);
  expect(r.files_changed_hidden).toBe(5); // 55 dirty in the window, 50 shown
});

test("files_changed_hidden is absent when nothing was hidden", async () => {
  const root = repoAt("2026-08-18T18:00:00-05:00");
  writeFileSync(join(root, "one.txt"), "x");
  const rec = (extra: object) => JSON.stringify({
    cwd: root, timestamp: "2026-08-18T18:30:00-05:00",
    sessionId: "77777777-0000-0000-0000-000000000000", ...extra,
  });
  const r = await parseTranscript(writeSession([
    rec({ type: "user", message: { role: "user", content: "go" } }),
    rec({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }),
  ]));
  expect(r.files_changed).toEqual(["one.txt"]);
  expect(r.files_changed_hidden).toBeUndefined();
});
