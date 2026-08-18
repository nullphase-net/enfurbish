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

export type Action = { entry: string; tool: string; qualifier: string; text: string };

export function findActions(secs: Section[]): Action[] {
  const out: Action[] = [];
  for (const s of secs) {
    for (const line of s.body) {
      const m = ACTION.exec(line);
      if (m) out.push({ entry: s.entry, tool: s.tool, qualifier: m[1] ?? "", text: m[2].trim() });
    }
  }
  return out;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Distinct tool-name spellings — the drift itself is worth reporting. */
function spellings(secs: Section[]): number {
  return new Set(secs.map(s => s.tool)).size;
}

export function reportActions(secs: Section[], tool: string | undefined, limit: number): string {
  const hit = matching(secs, tool);
  const acts = findActions(hit).reverse();
  const scope = tool ? ` · "${tool}" matches ${hit.length}/${secs.length} sections, ${spellings(hit)} spellings` : "";
  const head = `${acts.length} action${acts.length === 1 ? "" : "s"}${scope}`;
  if (acts.length === 0) return head;

  const lines = acts.slice(0, limit).map(a =>
    `${a.entry.slice(0, 10)}  ${clip(a.tool, 34).padEnd(34)}  ${a.qualifier ? a.qualifier + " " : ""}${clip(a.text, 100)}`);
  const hidden = acts.length - lines.length;
  return [head, ...lines, ...(hidden > 0 ? [`+${hidden} older`] : [])].join("\n");
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
       --actions [--tool <name>]   the improvement backlog, newest first
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

  const tmp = journal + "." + process.pid + ".tmp";
  try {
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, journal);
    process.exit(0);
  } catch (e: any) {
    try { unlinkSync(tmp); } catch {}
    process.stderr.write(`journal-append failed: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}
