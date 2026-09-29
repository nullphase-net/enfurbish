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

/**
 * An action that says "none" is a wrap reporting there was nothing to do. Written as
 * an Action it was an open row: 18 of them on 2026-09-26, each re-read by every later
 * wrap. It is kept as a note, not dropped, because some carry a real observation
 * after the "none" (#b6480a).
 */
const NONE = /^none\b/i;

/** Tools whose `action` said none — the append reports them while the writer is listening. */
export function noneActions(e: Entry): string[] {
  return (e.tools ?? []).filter(t => t.action && NONE.test(t.action.trim())).map(t => t.name);
}

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
    const none = !!t.action && NONE.test(t.action.trim());
    for (const n of [...(t.notes ?? []), ...(none ? [t.action!] : [])]) out.push(`- ${n}`);
    for (const c of t.closed ?? []) out.push(`- Closed: ${c}`);
    if (t.action && !none) out.push(`- Action: ${t.action}`);
  }
  return out.join("\n") + "\n";
}

// --- reading ---------------------------------------------------------------

export type Section = {
  /** Full `### ` heading text, minus the marker. */
  heading: string;
  /** Just the tool name — the heading up to the first separator. This is the part that drifts. */
  tool: string;
  /**
   * Timestamp of the `## ` entry this section belongs to. For an entry written with
   * the pre-formatEntry `  -  ` separator this is the whole header line: action ids
   * hash it, so re-parsing it would renumber every old action and orphan its closes.
   */
  entry: string;
  /** The project the entry came from, under either header separator; "" if absent. */
  slug: string;
  body: string[];
};

export function parseSections(text: string): Section[] {
  const out: Section[] = [];
  let entry = "";
  let slug = "";
  let cur: Section | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      entry = line.slice(3).split(SEP)[0].trim();
      slug = line.slice(3).split(/\s+[•-]\s+/)[1]?.trim() ?? "";
      cur = null;
    } else if (line.startsWith("### ")) {
      const heading = line.slice(4).trim();
      cur = { heading, tool: heading.split(SEP)[0].trim(), entry, slug, body: [] };
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
 *
 * A name with a `:` or a space matches when every part does, anywhere in the
 * heading: `continuity:wrap` is what `skills_invoked` hands wrap step 2, and it
 * reached 77 of 233 continuity sections because half of them spell the tool
 * `continuity (wrap, scan.ts)` (2026-09-29). Anything the whole string matched,
 * its parts still match.
 */
export function matching(secs: Section[], tool?: string): Section[] {
  if (!tool) return secs;
  const parts = tool.toLowerCase().split(/[:\s]+/).filter(Boolean);
  return secs.filter(s => {
    const h = s.heading.toLowerCase();
    return parts.every(p => h.includes(p));
  });
}

/**
 * `- Action: …`, `- **Action (recurring, unmoved):** …`, `- Action (10th
 * repetition): …`. The qualifier is signal, not noise — an action on its tenth
 * logging is the one worth reading first — so it is captured, not discarded.
 */
const ACTION = /^-\s*\*{0,2}Action\b\s*(\([^)]*\))?\s*\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/;

/**
 * The same, starting a sentence inside a bullet: "…at 0 calls. Action (third
 * repeat): scope it out." 53 raw-markdown-era bullets carry their action this way
 * and were invisible to `--actions`, so they could be neither read nor retired.
 * Tried only when ACTION misses, so no start-of-bullet line changes text or id. A
 * `Closed:` bullet is never an action, whatever it quotes.
 */
const MIDLINE_ACTION = /^-\s(?!\s*\*{0,2}Closed\b).*?[.!?)]\s+\*{0,2}Action\b\s*(\([^)]*\))?\s*\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/;

/** `- Closed: …`, `- **Closed (retired):** …` — the same shape, loose for the same reason. */
const CLOSED = /^-\s*\*{0,2}Closed\b\s*(\([^)]*\))?\s*\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/;

export type Action = { entry: string; slug: string; tool: string; qualifier: string; text: string; id: string };

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

function collectLines(secs: Section[], ...res: RegExp[]): Action[] {
  const out: Action[] = [];
  for (const s of secs) {
    for (const line of s.body) {
      let m: RegExpExecArray | null = null;
      for (const re of res) if ((m = re.exec(line))) break;
      if (!m) continue;
      const text = m[2].trim();
      out.push({ entry: s.entry, slug: s.slug, tool: s.tool, qualifier: m[1] ?? "", text, id: actionId(s.entry, s.tool, text) });
    }
  }
  return out;
}

export function findActions(secs: Section[]): Action[] {
  return collectLines(secs, ACTION, MIDLINE_ACTION);
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
function row(a: Action, withId = true, full = false): string {
  const id = withId ? `#${a.id}  ` : "";
  const slug = a.slug ? `[${clip(a.slug, 24)}] ` : "";
  return `${a.entry.slice(0, 10)}  ${id}${slug}${clip(a.tool, 34).padEnd(34)}  ${a.qualifier ? a.qualifier + " " : ""}${full ? a.text : clip(a.text, 100)}`;
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

export function reportActions(secs: Section[], tool: string | undefined, limit: number, full = false): string {
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
      ...shownDone.map(c => row(c, false, full)),
      ...(done.length > shownDone.length ? [`+${done.length - shownDone.length} older closed`] : []),
      "open:",
    ] : []),
    ...recent.map(a => row(a, true, full)),
    ...(hidden > 0 ? [`+${hidden} older`] : []),
    ...(stale.length ? ["stale:", STALE_GUIDANCE, ...stale.map(a => row(a, true, full))] : []),
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

/**
 * A close that names an #id and says the item stays open. The id is retired
 * wherever it sits in the sentence, so this is always a mistake, and "retired 1"
 * afterwards reads as success: two wraps did it on 2026-09-29. Over the 134 closes
 * then on disk this set hit 3, those two and one correct close ("moved: still open,
 * carried in …") that a writer would now have to reword. "re-open" and a bare "open"
 * are left out; both occur in correct closes.
 */
const KEEP_OPEN = /\b(?:stays?|still|remains?|kept|keeps?|keeping|left|leave|leaving)\s+(?:(?:it|this|them)\s+)?open\b|\bnot\s+(?:yet\s+)?(?:closed|retired)\b/i;

/** Why each close in an entry would retire an id it says to keep; empty when none would. */
export function keptOpen(added: Section[]): string[] {
  return findClosed(added).flatMap(c => {
    const ids = idsIn(c.text);
    const m = KEEP_OPEN.exec(c.text);
    return ids.length && m ? [`closed names ${ids.map(i => `#${i}`).join(" ")} and says "${m[0]}"`] : [];
  });
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
       --actions [<name>]          the improvement backlog: closed first, newest
                                   open next, oldest still-open under 'stale:' with
                                   what to do about them; <name> (or --tool <name>)
                                   filters to one tool, --full prints whole text
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
      // `--actions ponytail` parses "ponytail" as the value of --actions. Read only
      // --tool and it vanished: the whole backlog, exit 0, no scope in the head.
      : reportActions(secs, args.tool || args.actions || undefined, Number.isFinite(limit) ? limit : 20, "full" in args)) + "\n");
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
  let nones: string[] = [];
  if (raw.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Entry;
      entry = formatEntry(parsed);
      nones = noneActions(parsed);
    } catch (e: any) {
      process.stderr.write(`journal-append: stdin looked like JSON but ${e?.message ?? e}\n`);
      process.exit(2);
    }
  }

  // Refused before the write, not reported after it: once on disk the id is
  // retired, and re-opening it takes a fresh action. Raw markdown is checked too.
  const kept = keptOpen(parseSections(entry));
  if (kept.length) {
    process.stderr.write(`journal-append: nothing written\n${kept.join("\n")}\n` +
      "a close retires every #id it names, wherever it sits; say what stays open in notes\n");
    process.exit(2);
  }

  const existing = read();
  const base = existing.length === 0 || !existing.includes("# Claude Code tooling journal")
    ? HEADER + (existing.length ? existing + "\n" : "")
    : existing;
  // Ensure exactly one trailing newline before the new entry.
  const sep = base.endsWith("\n") ? "" : "\n";
  const next = base + sep + entry + (entry.endsWith("\n") ? "" : "\n");

  const closes = [
    ...reportCloses(parseSections(existing), parseSections(entry)),
    ...nones.map(n => `${n}: action said none, written as a note — omit action when there is none`),
  ];

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
