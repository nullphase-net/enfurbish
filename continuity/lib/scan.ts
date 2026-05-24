import { readdirSync, statSync, existsSync, createReadStream, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export function encodeCwd(cwd: string): string {
  return cwd.replaceAll("/", "-");
}

function safeRealpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
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
  // symlinked paths like /Users/tb/projects/... rather than the canonical
  // /Volumes/chonk/projects/... that owns the transcript dir. Canonicalize
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
   * Number of `system.compact_boundary` events in this transcript segment.
   * Non-zero means turn_count is undercount: the recorded jsonl is the
   * post-compaction segment and pre-compaction turns are not present.
   */
  compaction_count: number;
  skills_invoked: string[];
  files_edited: string[];
  files_read_count: number;
  degraded?: boolean;
  reason?: string;
};

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
  let filesReadCount = 0;
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

    if (obj.type === "user" && obj.message?.role === "user" && Array.isArray(obj.message.content)) {
      const hasText = obj.message.content.some((c: any) => c.type === "text");
      if (hasText) userTurns++;
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
          if (name === "Read") {
            filesReadCount++;
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
    files_read_count: filesReadCount,
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
