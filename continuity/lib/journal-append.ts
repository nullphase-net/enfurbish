#!/usr/bin/env bun
/**
 * The only writer to `~/.claude/tooling-journal.md`, and now the only reader too.
 *
 * The journal's shape used to live entirely in `wrap/SKILL.md` prose, with the
 * file header telling you to `grep '^- Action:'` for the backlog. Measured over
 * ~130 wraps: 241 action lines exist and that grep reached 143 of them. The 98 it
 * missed were the worst ones — `Action (recurring, unmoved)` ×17, `(recurring,
 * escalating)` ×6, `(10th repetition)` ×3, plus bolded `**Action`. Section
 * headings drifted the same way: 35 distinct spellings for `continuity` alone,
 * of which `^### continuity` reaches 109 of 134.
 *
 * So: `formatEntry` is the single place the on-disk shape is written, and the
 * readers match loosely enough to see the history the strict greps could not.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";

const HEADER = `# Claude Code tooling journal

Append-only record of how the user's tooling stack performed across sessions.
Each \`##\` section is one \`/wrap\` invocation.
Verdicts: \`helped\` / \`hurt\` / \`neutral\`.

Read it with \`journal-append.ts --journal <path> --actions\` (the improvement
backlog) or \`--recent <tool>\` (what prior wraps said about one tool). Both match
tool names loosely; a raw grep misses ~40% of what is here.

---

`;

/** `  •  ` — two spaces, U+2022, two spaces. Every field separator in the file. */
const SEP = "  •  ";

export type ToolNote = {
  name: string;
  /** Usage summary: "1 run", "8 fires", "6 calls, 0 errors". */
  usage?: string;
  verdict: string;
  notes?: string[];
  /** The highest-value field in the journal. Omit when there genuinely isn't one. */
  action?: string;
  /**
   * Standing actions this wrap retired — done, or deliberately abandoned, with why.
   *
   * `wrap/SKILL.md` has told six months of wraps that an unmoved action is "the one
   * to act on or explicitly retire", while offering no way to retire one. So nothing
   * ever was: `--actions` returns every action ever written, 312 of them, with closed
   * and open indistinguishable. pastiche's register gate was re-logged eight times
   * and all eight sat in the default view.
   *
   * Name the row's `#id` from `--actions`; that is what retires it. Prose alone was
   * the design until 2026-09-24 and it matched correctly every time — a reader could
   * pair each close with its action — but nothing removed a closed action from the
   * view, so all five stale rows were already closed and the block had shown the same
   * five for four days.
   */
  closed?: string[];
};

export type Entry = {
  timestamp: string;
  slug: string;
  session: string;
  arc: string;
  tools?: ToolNote[];
};

/** Render one wrap's journal entry. The single place the on-disk shape is written. */
export function formatEntry(e: Entry): string {
  const out = [
    `## ${e.timestamp}${SEP}${e.slug}${SEP}${e.session}`,
    "",
    `**Session arc:** ${e.arc}`,
  ];
  for (const t of e.tools ?? []) {
    const usage = t.usage ? `${SEP}${t.usage}` : "";
    out.push("", `### ${t.name}${usage}${SEP}verdict: ${t.verdict}`);
    for (const n of t.notes ?? []) out.push(`- ${n}`);
    for (const c of t.closed ?? []) out.push(`- Closed: ${c}`);
    if (t.action) out.push(`- Action: ${t.action}`);
  }
  return out.join("\n") + "\n";
}

// --- reading ---------------------------------------------------------------

export type Section = {
  /** Full `### ` heading text, minus the marker. */
  heading: string;
  /** Just the tool name — the heading up to the first separator. This is the part that drifts. */
  tool: string;
  /** Timestamp of the `## ` entry this section belongs to. */
  entry: string;
  body: string[];
};

export function parseSections(text: string): Section[] {
  const out: Section[] = [];
  let entry = "";
  let cur: Section | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      entry = line.slice(3).split(SEP)[0].trim();
      cur = null;
    } else if (line.startsWith("### ")) {
      const heading = line.slice(4).trim();
      cur = { heading, tool: heading.split(SEP)[0].trim(), entry, body: [] };
      out.push(cur);
    } else if (cur) {
      cur.body.push(line);
    }
  }
  return out;
}

/**
 * Substring match on the heading, case-insensitive. Deliberately loose: the
 * heading is free text a model composed, so `continuity` must reach
 * `Hook: SessionStart (ponytail + continuity + pastiche)` as well as
 * `continuity scan.ts`.
 */
export function matching(secs: Section[], tool?: string): Section[] {
  if (!tool) return secs;
  const q = tool.toLowerCase();
  return secs.filter(s => s.heading.toLowerCase().includes(q));
}

/**
 * `- Action: …`, `- **Action (recurring, unmoved):** …`, `- Action (10th
 * repetition): …`. The qualifier is signal, not noise — an action on its tenth
 * logging is the one worth reading first — so it is captured, not discarded.
 */
const ACTION = /^-\s*\*{0,2}Action\b\s*(\([^)]*\))?\s*\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/;

/** `- Closed: …`, `- **Closed (retired):** …` — the same shape, loose for the same reason. */
const CLOSED = /^-\s*\*{0,2}Closed\b\s*(\([^)]*\))?\s*\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/;

export type Action = { entry: string; tool: string; qualifier: string; text: string; id: string };

/**
 * Six hex of a content hash, so it needs no stored counter and appending an entry
 * never renumbers an older line. It is stable for as long as the line is, which in
 * an append-only file is forever.
 */
function actionId(entry: string, tool: string, text: string): string {
  return createHash("sha1").update(`${entry}\0${tool}\0${text}`).digest("hex").slice(0, 6);
}

/** Every `#id` a closed line names. Exactly six hex: a seven-char commit sha is not one. */
function idsIn(text: string): string[] {
  return [...text.matchAll(/#([0-9a-f]{6})\b/g)].map(m => m[1]);
}

function collectLines(secs: Section[], re: RegExp): Action[] {
  const out: Action[] = [];
  for (const s of secs) {
    for (const line of s.body) {
      const m = re.exec(line);
      if (!m) continue;
      const text = m[2].trim();
      out.push({ entry: s.entry, tool: s.tool, qualifier: m[1] ?? "", text, id: actionId(s.entry, s.tool, text) });
    }
  }
  return out;
}

export function findActions(secs: Section[]): Action[] {
  return collectLines(secs, ACTION);
}

export function findClosed(secs: Section[]): Action[] {
  return collectLines(secs, CLOSED);
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Distinct tool-name spellings — the drift itself is worth reporting. */
function spellings(secs: Section[]): number {
  return new Set(secs.map(s => s.tool)).size;
}

/** Open rows carry the `#id` a close names; closed rows already quote the ids they retire. */
function row(a: Action, withId = true): string {
  const id = withId ? `#${a.id}  ` : "";
  return `${a.entry.slice(0, 10)}  ${id}${clip(a.tool, 34).padEnd(34)}  ${a.qualifier ? a.qualifier + " " : ""}${clip(a.text, 100)}`;
}

/**
 * How many of the OLDEST open actions the default view always keeps visible.
 *
 * Recency alone made the backlog write-only. At 20 rows against 336 actions an
 * item left the view about four days after it was logged and was never shown
 * again — and an action nobody sees is one nobody can retire, which is why 132
 * sessions produced 5 closes. Measured on that same journal: 336 rows were 276
 * distinct ideas and only 1 of the 20 rows on screen was a repeat of another,
 * so this is not a duplication problem that grouping would fix — it is 93% of
 * the list being invisible. Five is answerable inside one wrap and small enough
 * not to crowd the recent head.
 */
const STALE_ROWS = 5;

// The block with a job attached. It sits under the rows it is about, and only when
// there are rows: an instruction the skill carried on every wrap did nothing for
// months, because retiring an action had no write behind it.
const STALE_GUIDANCE =
  "  answer each: still open / already done / never going to happen. Retire it through the closed array of this wrap's entry, naming its #id, or it comes back next session.";

export function reportActions(secs: Section[], tool: string | undefined, limit: number): string {
  const hit = matching(secs, tool);
  // Retirement is global: a close is written under whatever heading the wrap was
  // on, which is rarely the heading of the action it retires.
  const retired = new Set(findClosed(secs).flatMap(c => idsIn(c.text)));
  const all = findActions(hit).reverse();
  const acts = all.filter(a => !retired.has(a.id));
  const done = findClosed(hit).reverse();
  // A close that names no id is every close written before ids existed, and any
  // later one that forgot: it reads as a retirement and removes nothing.
  const bare = done.filter(c => idsIn(c.text).length === 0).length;
  const scope = tool ? ` · "${tool}" matches ${hit.length}/${secs.length} sections, ${spellings(hit)} spellings` : "";
  const closedNote = done.length
    ? ` · ${done.length} closed${bare ? ` (${bare} name${bare === 1 ? "s" : ""} no #id)` : ""}`
    : "";
  const head = `${acts.length} open of ${all.length}${closedNote}${scope}`;
  if (acts.length === 0 && done.length === 0) return head;

  const recent = acts.slice(0, limit);
  // The oldest open actions, minus whatever the recent head already shows. Read
  // top to bottom the block is a timeline: newest, the hidden middle, oldest.
  const stale = acts.length > recent.length
    ? acts.slice(Math.max(recent.length, acts.length - STALE_ROWS))
    : [];
  const hidden = acts.length - recent.length - stale.length;
  // Closed first, so a reader meets what was retired before logging it again. Capped
  // like the head: uncapped was right at 20 closes, but retiring the backlog on
  // 2026-09-24 took 24 more (naming 134 ids), and every wrap would print all 44.
  const shownDone = done.slice(0, limit);
  return [
    head,
    ...(done.length ? [
      "closed:",
      ...shownDone.map(c => row(c, false)),
      ...(done.length > shownDone.length ? [`+${done.length - shownDone.length} older closed`] : []),
      "open:",
    ] : []),
    ...recent.map(a => row(a)),
    ...(hidden > 0 ? [`+${hidden} older`] : []),
    ...(stale.length ? ["stale:", STALE_GUIDANCE, ...stale.map(a => row(a))] : []),
  ].join("\n");
}

/**
 * What an appended entry's closes did, checked against the journal before it. A
 * close that retires nothing looks exactly like one that worked until the next
 * `--actions`, so the append says so while the writer still has the ids in hand.
 * Silent when the entry closes nothing.
 */
export function reportCloses(before: Section[], added: Section[]): string[] {
  const known = new Set(findActions(before).map(a => a.id));
  // Sets: one close may repeat an id in its prose, and a count of mentions is not a
  // count of actions retired.
  const retired = new Set<string>();
  const problems = new Set<string>();
  for (const c of findClosed(added)) {
    const ids = idsIn(c.text);
    if (ids.length === 0) problems.add(`closed line names no #id, retires nothing: "${clip(c.text, 60)}"`);
    for (const id of ids) {
      if (known.has(id)) retired.add(`#${id}`);
      else problems.add(`#${id} matches no action`);
    }
  }
  return [...(retired.size ? [`retired ${retired.size}: ${[...retired].join(" ")}`] : []), ...problems];
}

export function reportRecent(secs: Section[], tool: string, limit: number): string {
  const hit = matching(secs, tool);
  const head = `${hit.length} section${hit.length === 1 ? "" : "s"} · "${tool}" · ${spellings(hit)} spellings · showing last ${Math.min(limit, hit.length)}`;
  if (hit.length === 0) return head;
  const shown = hit.slice(-limit).reverse()
    .map(s => [`### ${s.heading}   [${s.entry.slice(0, 10)}]`, ...s.body.filter(l => l.trim())].join("\n"));
  return [head, "", ...shown].join("\n");
}

// --- CLI -------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    // Bare flags (--actions) take no value; only consume a non-flag token.
    out[argv[i].slice(2)] = next && !next.startsWith("--") ? (i++, next) : "";
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const USAGE = `usage: journal-append.ts --journal <path> [mode]
       (no mode)                   append: an Entry as JSON on stdin, or raw markdown
       --actions [--tool <name>]   the improvement backlog: closed first, newest
                                   open next, oldest still-open under 'stale:' with
                                   what to do about them
       --recent <name>             what prior wraps said about one tool
       --limit <n>                 cap rows (default 20 actions / 5 sections)`;

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const journal = args.journal;
  if (!journal) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  const read = () => (existsSync(journal) ? readFileSync(journal, "utf8") : "");

  if ("actions" in args || "recent" in args) {
    // `--recent` with no value parses to "", which `matching()` reads as "no
    // filter" and reports the whole journal — 731 sections against a flag that
    // asked about one tool. An empty needle is arg misuse, not a wildcard.
    if ("recent" in args && !args.recent.trim()) {
      process.stderr.write(`--recent needs a tool name\n${USAGE}\n`);
      process.exit(2);
    }
    const limit = Number.parseInt(args.limit || "", 10);
    const secs = parseSections(read());
    process.stdout.write(("recent" in args
      ? reportRecent(secs, args.recent, Number.isFinite(limit) ? limit : 5)
      : reportActions(secs, args.tool || undefined, Number.isFinite(limit) ? limit : 20)) + "\n");
    process.exit(0);
  }

  const raw = await readStdin();
  if (raw.trim().length === 0) {
    // No-op; do not touch the file.
    process.exit(0);
  }
  // JSON in means this file renders the shape. Raw markdown still appends
  // verbatim — retroactive and hand-written entries have to stay possible.
  let entry = raw;
  if (raw.trimStart().startsWith("{")) {
    try {
      entry = formatEntry(JSON.parse(raw) as Entry);
    } catch (e: any) {
      process.stderr.write(`journal-append: stdin looked like JSON but ${e?.message ?? e}\n`);
      process.exit(2);
    }
  }

  const existing = read();
  const base = existing.length === 0 || !existing.includes("# Claude Code tooling journal")
    ? HEADER + (existing.length ? existing + "\n" : "")
    : existing;
  // Ensure exactly one trailing newline before the new entry.
  const sep = base.endsWith("\n") ? "" : "\n";
  const next = base + sep + entry + (entry.endsWith("\n") ? "" : "\n");

  const closes = reportCloses(parseSections(existing), parseSections(entry));

  const tmp = journal + "." + process.pid + ".tmp";
  try {
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, journal);
    if (closes.length) process.stdout.write(closes.join("\n") + "\n");
    process.exit(0);
  } catch (e: any) {
    try { unlinkSync(tmp); } catch {}
    process.stderr.write(`journal-append failed: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}
