import { readdirSync, statSync, existsSync, createReadStream, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

export function encodeCwd(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** `safeRealpath`, but a path that no longer exists still gets its directory resolved. */
function canonical(p: string): string {
  try { return realpathSync(p); } catch { /* deleted: resolve what is left */ }
  try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; }
}

type FindArgs = { cwd: string; projectsRoot?: string };
type FindResult = { path: string; sessionId: string; cwd: string; lastEventTs: string };

async function peekFirstCwdAndLastTs(path: string): Promise<{ firstCwd?: string; lastTs?: string }> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let firstCwd: string | undefined;
  let lastTs: string | undefined;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (firstCwd === undefined && typeof obj.cwd === "string") firstCwd = obj.cwd;
      if (typeof obj.timestamp === "string") lastTs = obj.timestamp;
    } catch { /* skip malformed line */ }
  }
  return { firstCwd, lastTs };
}

export async function findTranscript({ cwd, projectsRoot }: FindArgs): Promise<FindResult> {
  const root = projectsRoot ?? join(homedir(), ".claude", "projects");
  // 2026-05-22: callers pass cwd via $(pwd), which on macOS resolves
  // symlinked paths like /Users/me/projects/... rather than the canonical
  // /Volumes/data/projects/... that owns the transcript dir. Canonicalize
  // both sides so the lookup survives the symlink boundary.
  const canonicalCwd = safeRealpath(cwd);
  const candidates: string[] = [];
  const dirsToTry: string[] = [join(root, encodeCwd(canonicalCwd))];
  if (canonicalCwd !== cwd) dirsToTry.push(join(root, encodeCwd(cwd)));
  for (const encodedDir of dirsToTry) {
    if (!existsSync(encodedDir)) continue;
    for (const name of readdirSync(encodedDir)) {
      if (name.endsWith(".jsonl")) candidates.push(join(encodedDir, name));
    }
  }
  if (candidates.length === 0) {
    if (!existsSync(root)) throw new Error(`transcript not found: projects root ${root} missing`);
    for (const dir of readdirSync(root)) {
      const full = join(root, dir);
      if (!statSync(full).isDirectory()) continue;
      for (const name of readdirSync(full)) {
        if (name.endsWith(".jsonl")) candidates.push(join(full, name));
      }
    }
  }
  let best: FindResult | null = null;
  for (const p of candidates) {
    const { firstCwd, lastTs } = await peekFirstCwdAndLastTs(p);
    if (!firstCwd) continue;
    const canonicalFirstCwd = safeRealpath(firstCwd);
    const matches = firstCwd === cwd
      || firstCwd === canonicalCwd
      || canonicalFirstCwd === cwd
      || canonicalFirstCwd === canonicalCwd;
    if (!matches) continue;
    if (!lastTs) continue;
    if (best === null || lastTs > best.lastEventTs) {
      const sid = basename(p, ".jsonl");
      best = { path: p, sessionId: sid, cwd: firstCwd, lastEventTs: lastTs };
    }
  }
  if (!best) throw new Error(`transcript not found for cwd ${cwd}`);
  return best;
}

export type ScanOk = {
  ok: true;
  session_id: string;
  session_id_short: string;
  transcript_path: string;
  cwd: string;
  cwd_slug: string;
  session_start: string;
  session_end: string;
  duration_ms: number;
  turn_count: { user: number; model: number };
  tools: Record<string, { calls: number; errors: number }>;
  mcp: Record<string, { calls: number; errors: number }>;
  hooks: Record<string, { fired: number }>;
  /**
   * Number of `system.compact_boundary` events in the transcript. A fact about the
   * session, not a caveat on the counts: a compaction does not truncate the jsonl,
   * so every count here covers the whole session either side of one. Both compacted
   * transcripts on this machine keep their pre-compaction records (Claude Code
   * 2.1.268, 2.1.274; one has 12 user turns before its boundary, 3 after).
   * A scan taken before a late compaction under-reports only this number.
   */
  compaction_count: number;
  skills_invoked: string[];
  files_edited: string[];
  /**
   * Present when `files_edited` is not the whole story. Either it is empty and the
   * session used Bash, so a write via `sed`/heredoc/`cp` would leave no trace here,
   * or git reports a change it does not list. Auto mode routes every write through
   * Bash, so this is the normal state there, not an anomaly. The second case is the
   * dangerous one: a populated list read as complete (symbion 092, 5 of 7 changed
   * paths listed). Absent means git saw nothing the list lacks.
   */
  files_edited_blind?: true;
  /**
   * Files git says changed since `session_start`, in the repo holding `cwd`, relative
   * to that repo's root: commits in the window plus everything still dirty or
   * untracked in the working tree. Present whenever
   * Bash ran, because that is when `files_edited` stops being the whole story --- not
   * only when it is empty. Absent (rather than empty) when git could not answer: no
   * repo, no git, unparseable start timestamp. Empty means git looked and found none.
   * Capped at `FILES_CHANGED_CAP`; whatever the cap drops is counted in
   * `files_changed_hidden` rather than discarded, because a truncated list that does
   * not say it is truncated reads exactly like a complete one.
   */
  files_changed?: string[];
  /** How many `files_changed` entries the cap dropped. Absent when it dropped none. */
  files_changed_hidden?: number;
  files_read_count: number;
  degraded?: boolean;
  reason?: string;
};

/** Rows of `files_changed` a wrap reads before the list stops informing it. */
export const FILES_CHANGED_CAP = 50;

/**
 * What git says changed under `cwd` since `iso` --- the fallback for `files_edited`.
 *
 * `files_edited` is built from Edit/Write tool records, so a write performed with a
 * heredoc, `sed` or a python patch script leaves nothing behind. Auto mode routes
 * every write through Bash, which empties the field by construction: measured across
 * eight consecutive wraps, `files_edited []` sat against 6, 2, 14 and 11 real file
 * changes. The transcript cannot answer this question; the repo can.
 *
 * Two sources, because neither alone is complete: commits in the window catch work
 * already landed, and porcelain catches work still dirty at wrap time --- which is
 * most of it, since /wrap runs before the final commit as often as after.
 *
 * THIS IS REPO-SCOPED, NOT SESSION-SCOPED. It answers "what is different under this
 * cwd since `iso`", not "what did this session do", and the two diverge whenever the
 * tree has another writer: a concurrent session, a subagent in a different cwd of the
 * same repo, or the user in an editor. `git log --since` also takes any author's
 * commits, and only on HEAD --- a concurrent session on another branch is invisible
 * here, so the error runs in both directions. Callers must corroborate before
 * attributing anything in this list to the session.
 *
 * The dirty half is filtered by mtime, because `git status` is not time-bounded at
 * all and reports work that predates the session entirely. Measured on this repo:
 * 19 dirty files, of which one --- a version bump left over from a prior session ---
 * was never touched by the session that reported it. A deleted path cannot be
 * stat'd and is kept rather than dropped; missing a real deletion costs more than
 * the occasional stale one.
 *
 * BLIND TO UNTRACKED-AND-GITIGNORED PATHS. Plain `--porcelain` omits them, so a
 * project that ignores its own notes, `.private/` docs or `CLAUDE.md` shows edits to
 * them as nothing: 2026-09-18 listed 18 files and 2026-09-21 listed 17, both without
 * the `CLAUDE.md` and `NEXT_SESSION.md` those sessions rewrote. Absence here is not
 * evidence a path went untouched. `--ignored` was rejected: it would also list build
 * output and dependency dirs touched in the window. The instruction files are the
 * ones that matter, and /wrap already asks `affirm --since` about exactly those.
 *
 * null means git could not answer. That is not the same fact as an empty list.
 * The full list comes back uncapped; the caller caps it, because a cap that discards
 * the count of what it discarded is the silent-truncation this repo bans.
 */
export function gitChangedSince(cwd: string, iso: string): string[] | null {
  if (!cwd || !(Date.parse(iso) > 0)) return null;
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 8 << 20 });

  const log = git("log", "--name-only", "--pretty=format:", `--since=${iso}`);
  if (log.status !== 0) return null;
  // Both lists below are relative to the repo ROOT whatever `-C` says, and the cwd can
  // be a subdirectory of it. Joined to the cwd instead, every stat from a subdirectory
  // missed and every dirty file was kept as a "deletion".
  const loc = repoLocation(cwd);
  if (!loc) return null;

  // `--porcelain` is stable across git versions by contract; `-z` avoids the quoting
  // it applies to paths with spaces. XY status is the first two bytes, path the rest.
  const dirty = git("status", "--porcelain", "-z");

  const seen = new Set<string>();
  for (const f of log.stdout.split("\n")) {
    const t = f.trim();
    if (t) seen.add(t);
  }
  if (dirty.status === 0) {
    const cutoff = Date.parse(iso);
    // A rename emits two NUL fields: `R  <dest>` then a bare `<src>` with no status
    // bytes. Rather than track which field is which, take a path off either shape ---
    // the source of a rename did change, so keeping it is right, not a leak.
    for (const rec of dirty.stdout.split("\0")) {
      if (!rec) continue;
      const rel = /^[ MADRCU?!]{2} /.test(rec) ? rec.slice(3) : rec;
      let m: number;
      try { m = statSync(join(loc.top, rel)).mtimeMs; } catch { seen.add(rel); continue; }
      if (m > cutoff) seen.add(rel);
    }
  }
  // The wrap writes this cwd's pointer inside the session window, so it always
  // qualified and reported the scan's own artifact as session work. A pointer in any
  // other directory belongs to another cwd's wrap and stays.
  seen.delete(`${loc.prefix}NEXT_SESSION.md`);
  return [...seen].sort();
}

/** The repo root holding `cwd`, and `cwd`'s path under it (`sub/`, or `` at the root). */
function repoLocation(cwd: string): { top: string; prefix: string } | null {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--show-prefix"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const [top, prefix = ""] = r.stdout.split("\n");
  return top ? { top, prefix } : null;
}

/**
 * Does git report a change `edited` does not list? Compared canonically, because an
 * Edit's `file_path` can be spelled through a symlink git never uses.
 */
function editsMiss(changed: string[], edited: string[], top: string): boolean {
  const have = edited.map(canonical);
  return changed.some(rel => {
    const abs = canonical(join(top, rel));
    // git collapses an untracked directory to `dir/`; any edit inside it covers it.
    return rel.endsWith("/") ? !have.some(e => e.startsWith(`${abs}/`)) : !have.includes(abs);
  });
}

/**
 * User-role records the transcript synthesises rather than the human typing them.
 * Counting these — and, before 2026-08-18, counting nothing else — is what produced
 * the chronic `turn_count.user` undercount logged across six wraps: a real prompt
 * arrives as bare-string content, so the old `Array.isArray` guard skipped every
 * one of them while `<task-notification>` records piled up around them.
 *
 * `Base directory for this skill:` is how a loaded SKILL.md enters the transcript,
 * and it is the one shape here that is not tag-delimited. The slash command that
 * triggered the load is already counted one record earlier, so counting the body
 * counts a single user action twice. Measured on session c9fac9d5: 10 counted
 * against 7 real prompts, and all three of the excess were skill bodies — not the
 * background-task notifications the wrap blamed, which this pattern already caught.
 * The sign of this field's error is not stable; check the records, not the prior.
 */
const SYNTHETIC_USER = /^\s*(<(task-notification|local-command-caveat|local-command-stdout|bash-stdout|system-reminder|thinking)>|Base directory for this skill:|\[Request interrupted by user)/;

/**
 * Flags Claude Code sets on user-role records it wrote itself. Gated on the flag, not
 * the text: a /loop re-fire is the stored prompt verbatim, and only `isMeta` tells it
 * from the human typing it again. Session 7c452ae9 read 28 user turns against 24
 * (13 typed + 11 slash commands); the excess was three `[Request interrupted by
 * user]` and one relayed agent message. Surveyed 2026-09-24 over all 426 local
 * transcripts: 451 counted records carried `isMeta`, across 35 prefixes, every one
 * synthetic (agent relays, /loop re-fires, skill bodies and re-invocations, image
 * metadata, stop-hook feedback); `isCompactSummary` marks the summary a compaction
 * injects, one per compaction.
 */
function isSynthetic(obj: any, text: string): boolean {
  return obj.isMeta === true || obj.isCompactSummary === true || SYNTHETIC_USER.test(text);
}

/** `<command-name>/continuity:wrap</command-name>` — how a slash command reaches the transcript. */
const COMMAND_NAME = /<command-name>\/?([^<]+)<\/command-name>/;

/** Text a user record carries, from either content shape. Empty for tool-result-only records. */
function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

export async function parseTranscript(path: string): Promise<ScanOk> {
  let degraded = false;
  let reason = "";

  let session_id = basename(path, ".jsonl");
  let cwd = "";
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  const tools: Record<string, { calls: number; errors: number }> = {};
  const mcp: Record<string, { calls: number; errors: number }> = {};
  const hooks: Record<string, { fired: number }> = {};
  const skillsSet = new Set<string>();
  const editsByFile = new Map<string, number>();   // file_path → last-seen index
  let editIdx = 0;
  const filesRead = new Set<string>(); // distinct paths, like files_edited; tools.Read.calls counts calls
  let userTurns = 0;
  let modelTurns = 0;
  let compactionCount = 0;
  // tool_use_id → "tools" or "mcp" + name, so we can credit errors back.
  const inflight = new Map<string, { bucket: "tools" | "mcp"; name: string }>();

  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  let lastLineRaw = "";
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    lastLineRaw = line;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      degraded = true;
      reason = `JSONL parse error at line ${lineNo}`;
      continue;
    }
    if (obj.isSidechain) continue; // skip subagent events
    if (typeof obj.cwd === "string" && !cwd) cwd = obj.cwd;
    if (typeof obj.timestamp === "string") {
      if (!firstTs) firstTs = obj.timestamp;
      lastTs = obj.timestamp;
    }
    if (typeof obj.sessionId === "string") session_id = obj.sessionId;

    if (obj.type === "attachment" && obj.attachment?.hookEvent) {
      const ev: string = obj.attachment.hookEvent;
      hooks[ev] = hooks[ev] ?? { fired: 0 };
      hooks[ev].fired++;
      continue;
    }

    if (obj.type === "system" && obj.subtype === "compact_boundary") {
      compactionCount++;
      continue;
    }

    if (obj.type === "user" && obj.message?.role === "user") {
      const text = userText(obj.message.content);
      if (text.trim() && !isSynthetic(obj, text)) userTurns++;
      const cmd = COMMAND_NAME.exec(text);
      if (cmd) skillsSet.add(cmd[1].trim());

      if (Array.isArray(obj.message.content)) {
        for (const c of obj.message.content) {
          if (c.type === "tool_result") {
            const ent = inflight.get(c.tool_use_id);
            if (ent && c.is_error) {
              const bucket = ent.bucket === "tools" ? tools : mcp;
              if (bucket[ent.name]) bucket[ent.name].errors++;
            }
            inflight.delete(c.tool_use_id);
          }
        }
      }
    }

    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      let isModelTurn = false;
      for (const c of obj.message.content) {
        if (c.type === "text") isModelTurn = true;
        if (c.type === "tool_use") {
          isModelTurn = true;
          const name: string = c.name;
          const isMcp = name.startsWith("mcp__");
          const bucket = isMcp ? mcp : tools;
          bucket[name] = bucket[name] ?? { calls: 0, errors: 0 };
          bucket[name].calls++;
          inflight.set(c.id, { bucket: isMcp ? "mcp" : "tools", name });

          if (name === "Skill" && typeof c.input?.skill === "string") {
            skillsSet.add(c.input.skill);
          }
          if ((name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") &&
              typeof c.input?.file_path === "string") {
            editsByFile.set(c.input.file_path, editIdx++);
          }
          if (name === "Read" && typeof c.input?.file_path === "string") {
            filesRead.add(c.input.file_path);
          }
        }
      }
      if (isModelTurn) modelTurns++;
    }
  }

  // If we logged a parse error on the final line, treat that as a trailing-truncation note rather than a hard failure.
  if (degraded && reason.startsWith("JSONL parse error at line")) {
    if (!lastLineRaw.trim().endsWith("}")) {
      reason = "trailing line truncated";
    }
  }

  // files_edited: most-recently-edited first, capped at 50.
  const files_edited = [...editsByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([p]) => p);

  if (!firstTs || !lastTs) {
    degraded = true;
    if (!reason) reason = "no timestamps in transcript";
    firstTs ??= "";
    lastTs ??= "";
  }

  // Whenever Bash ran, not only when files_edited came back empty: one Edit call
  // beside twenty heredoc writes yields a non-empty list that is still not the story.
  const bash = (tools.Bash?.calls ?? 0) > 0;
  const gitChanged = bash ? gitChangedSince(cwd, firstTs!) : null;
  const top = gitChanged?.length ? repoLocation(cwd)?.top : undefined;
  // Against every edit, not the capped list: a 51st edit is still an edit.
  const blind = bash && (files_edited.length === 0
    || (top !== undefined && editsMiss(gitChanged!, [...editsByFile.keys()], top)));

  return {
    ok: true,
    session_id,
    session_id_short: session_id.slice(0, 8),
    transcript_path: path,
    cwd,
    cwd_slug: cwd ? basename(cwd) : "",
    session_start: firstTs!,
    session_end: lastTs!,
    duration_ms: firstTs && lastTs ? new Date(lastTs).getTime() - new Date(firstTs).getTime() : 0,
    turn_count: { user: userTurns, model: modelTurns },
    tools,
    mcp,
    hooks,
    compaction_count: compactionCount,
    skills_invoked: [...skillsSet],
    files_edited,
    ...(blind ? { files_edited_blind: true } : {}),
    ...(gitChanged ? { files_changed: gitChanged.slice(0, FILES_CHANGED_CAP) } : {}),
    ...(gitChanged && gitChanged.length > FILES_CHANGED_CAP
      ? { files_changed_hidden: gitChanged.length - FILES_CHANGED_CAP }
      : {}),
    files_read_count: filesRead.size,
    ...(degraded ? { degraded: true, reason } : {}),
  };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1];
      out[k] = v;
      i++;
    }
  }
  return out;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd ?? process.cwd();
  const projectsRoot = args["projects-root"];
  try {
    const t = await findTranscript({ cwd, projectsRoot });
    const r = await parseTranscript(t.path);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    process.exit(0);
  } catch (e: any) {
    process.stdout.write(JSON.stringify({
      ok: false,
      degraded: true,
      reason: String(e?.message ?? e),
    }, null, 2) + "\n");
    process.exit(0);
  }
}
