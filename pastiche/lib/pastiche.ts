#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type Language = { code: string; name: string; domains: string };
export type Config = {
  ledger: string;
  languages: Language[];
  /** Stale items re-surfaced per session. */
  due: number;
  /** New items introduced per session. 0 turns introduction off entirely. */
  fresh: number;
};
export type Entry = {
  line: string;
  code: string;
  /** Everything between the language code and the first `|` — script, romanization, gloss. */
  term: string;
  introduced: string;
  seen: string;
  /**
   * What this term is ABOUT — `rf, hardware`, `family`, `math`. Empty when the
   * line carries no tag, which is most of the ledger and is fine: an untagged
   * item surfaces exactly as it always did.
   */
  subject: string;
};

const DEFAULT_DIR = join(homedir(), ".claude", "pastiche");

export function pasticheDir(): string {
  return process.env.PASTICHE_DIR || DEFAULT_DIR;
}

export function expandTilde(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(dir = pasticheDir()): Config {
  const fallback: Config = { ledger: join(dir, "ledger.md"), languages: [], due: 5, fresh: 2 };
  const path = join(dir, "config.json");
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      ledger: typeof raw.ledger === "string" ? expandTilde(raw.ledger) : fallback.ledger,
      languages: Array.isArray(raw.languages) ? raw.languages : fallback.languages,
      due: Number.isFinite(raw.due) ? raw.due : fallback.due,
      fresh: Number.isFinite(raw.fresh) ? raw.fresh : fallback.fresh,
    };
  } catch {
    // Malformed config must not break the session — fall back to defaults.
    return fallback;
  }
}

const CODE = /^- ([a-z]{2}): /;
const DATE = /(\d{4}-\d{2}-\d{2})/;
const SEEN = /seen: (\d{4}-\d{2}-\d{2})/;
// Lazy + lookahead so the capture stops before the space that separates it
// from the next ` | ` field. A greedy `[^|]+` swallows that space, and a
// re-tag then writes `subj: x| seen:` — the separator silently degrades.
const SUBJ = /subj: ([^|]+?)(?=\s*\||\s*$)/;
/** A `key: value` field, as opposed to the free-text marks field. */
const NAMED = /^\w+:\s/;

/**
 * Parse ledger lines of the shape:
 *   `- km: ទឹក (teuk) — water | 2026-08-05 | ✓✓ | subj: family | seen: 2026-08-12`
 * The marks and `subj:` fields are both optional. A line with no `seen:` falls back to its
 * introduce date, so a hand-written line is never invisible to the sort.
 */
export function parseLedger(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split("\n")) {
    const code = CODE.exec(line);
    if (!code) continue;
    const parts = line.split(" | ");
    const introduced = DATE.exec(parts[1] ?? "")?.[1] ?? "";
    out.push({
      line,
      code: code[1],
      term: parts[0].slice(code[0].length).trim(),
      introduced,
      seen: SEEN.exec(line)?.[1] ?? introduced,
      subject: SUBJ.exec(line)?.[1].trim() ?? "",
    });
  }
  return out;
}

/**
 * Stalest-first by `seen:`. Ties keep ledger order (Array.sort is stable), so
 * the selection is deterministic for a given file.
 *
 * ponytail: rotation comes from restamping, not from the sort. An item the
 * session used gets today's date and drops to the back on its own. If nothing
 * restamps, the same items keep surfacing — which is the correct failure mode
 * for vocabulary that never got reinforced.
 */
export function stalest(entries: Entry[], n: number): Entry[] {
  return [...entries].sort((a, b) => a.seen.localeCompare(b.seen)).slice(0, n);
}

/** Rewrite `seen:` to `date` on every ledger line containing `needle`. */
export function restamp(text: string, needle: string, date: string): string {
  return text
    .split("\n")
    .map(l => (CODE.test(l) && l.includes(needle) ? l.replace(SEEN, `seen: ${date}`) : l))
    .join("\n");
}

/**
 * Prepend a ✓ to the marks field and restamp, on every line containing
 * `needle` — marking only ever happens because the item was just used.
 *
 * The marks field is optional and free text (`✓✓ family baseline`), so a line
 * without one gets it inserted before `seen:`, and a hand-written line with no
 * `seen:` at all gets both appended. Marks accumulate and are never decayed;
 * `seen:` is what drives selection.
 */
export function mark(text: string, needle: string, date: string): string {
  return text
    .split("\n")
    .map(l => {
      if (!CODE.test(l) || !l.includes(needle)) return l;
      if (!SEEN.test(l)) return `${l} | ✓ | seen: ${date}`;
      const parts = l.split(" | ");
      const head = parts.slice(0, -1);
      // The marks slot is the first field after the introduce date that is not
      // a named `key: value` one, so a `subj:` tag never collects a ✓.
      let i = 2;
      while (i < head.length && NAMED.test(head[i])) i++;
      if (i < head.length) head[i] = `✓${head[i]}`;
      else head.splice(2, 0, "✓");
      return [...head, `seen: ${date}`].join(" | ");
    })
    .join("\n");
}

/**
 * Set (or replace) the `subj:` tag on every line containing `needle`.
 *
 * It exists because the tag has to reach the ~20 items already in rotation, and
 * those lines were written before the field did. A field with no writer for the
 * lines that predate it is a field that stays empty forever.
 */
export function tag(text: string, needle: string, subject: string): string {
  return text
    .split("\n")
    .map(l => {
      if (!CODE.test(l) || !l.includes(needle)) return l;
      if (SUBJ.test(l)) return l.replace(SUBJ, `subj: ${subject}`);
      if (!SEEN.test(l)) return `${l} | subj: ${subject}`;
      const parts = l.split(" | ");
      return [...parts.slice(0, -1), `subj: ${subject}`, parts.at(-1)].join(" | ");
    })
    .join("\n");
}

/**
 * Entry lines containing `needle`. The writers below rewrite exactly these, so
 * the CLI uses it to tell "nothing matched" apart from "matched, already
 * current" — a rewrite that changes no bytes is otherwise indistinguishable
 * from a miss, and reporting it as one loses real state.
 */
export function matchingLines(text: string, needle: string): string[] {
  return text.split("\n").filter(l => CODE.test(l) && l.includes(needle));
}

/**
 * Render a ledger line. The only place the on-disk format is written.
 * `marks` seeds the optional third field — `✗` for a correction, so a later
 * `mark()` reads `✓✗`: got it wrong once, right since. `subject` seeds `subj:`,
 * which always follows the marks so `mark()` can find the marks by position.
 */
export function formatEntry(
  code: string,
  body: string,
  date: string,
  marks?: string,
  subject?: string,
): string {
  const fields = [body, date];
  if (marks) fields.push(marks);
  if (subject) fields.push(`subj: ${subject}`);
  fields.push(`seen: ${date}`);
  return `- ${code}: ${fields.join(" | ")}`;
}

/**
 * Render a correction body: what they said, what it should be, and why.
 *
 * Corrections live in the ledger rather than in `languages/<code>.md` because
 * they need rotation. The notes files are invariant facts about the language;
 * a correction is a fact about this learner, and it should keep surfacing until
 * it sticks and then rotate out on its own. The wrong form is kept because it is
 * the half that predicts the next mistake.
 */
export function formatCorrection(wrong: string, right: string, rule: string): string {
  return `${wrong} → ${right} — ${rule}`;
}

export function buildContext(opts: {
  cfg: Config;
  due: Entry[];
  notes: string;
  pluginRoot: string;
}): string {
  const { cfg, due, notes, pluginRoot } = opts;
  const langs = cfg.languages.length
    ? cfg.languages.map(l => `- ${l.name} (${l.code}) — ${l.domains}`).join("\n")
    : "- (none configured — see the plugin README)";
  const dueList = due.length
    ? due.map(e =>
        `  - ${e.code}: ${e.term}${e.subject ? `  [${e.subject}]` : ""}  [last surfaced ${e.seen}]`,
      ).join("\n")
    : "  (nothing due yet — the ledger is empty or not created; the first terms you\n" +
      "   introduce start it)";
  const freshRule = cfg.fresh > 0
    ? `\nIntroduce up to ${cfg.fresh} new term${cfg.fresh === 1 ? "" : "s"} per session, drawn from what the work is
actually about. Append each to the ledger. This budget is separate from the due
list — reinforcement never crowds it out. No natural opening, though, means
spend less; filler is worse than silence.\n`
    : "";

  return `# pastiche — ambient language infusion

Weave a few terms per session into your responses, tied to whatever the work
actually is. Steady drip, not quizzing. Never turn the session into a lesson.

Languages, and when to reach for each:
${langs}

Re-surface the due items listed below — that is what the learner is forgetting
right now. Re-teach without ceremony; forgetting is expected, not a failure.

A due item the session gives no opening is a scheduling mismatch, not a retention
failure. Leave it due rather than forcing it; it rotates back. The test is the one
the new-term budget already uses: does this session's work touch the term's subject.

The bracket after a due term IS that subject — [rf, hardware], [family]. Read it
and answer the test; don't re-derive the subject from the gloss when the line already
says it. An item with no bracket is untagged, not subject-free: derive it as before,
and tag it with --tag once you know. Tag what you add, too — an untagged addition is
the next session re-deriving what this one already knew.

A term fits only where its gloss fits. A due word that looks like the English word
your sentence needs but glosses differently is a false friend: the shape is the
trap, not the opening. Use it in the glossed meaning or leave it due.
${freshRule}
When the learner uses a term themselves, unprompted, they are priming you:
- Already in the ledger → append a ✓ to its line and restamp it.
- Not in the ledger → they already have it. Append it with a ✓. Confirm or
  correct in a clause and move on; never teach it back at them.

When they correct you — a wrong form, a bad ending, a mangled tense — record it.
That is the highest-value signal this system gets, and it is not vocabulary: the
wrong form is kept next to the right one because it is what predicts the next
mistake. A correction rotates like any other entry; --mark it once you get it right.

Non-Latin scripts: always script + informal phonetic romanization + gloss —
ទឹក (teuk) — water. Romanization is load-bearing; use informal phonetic
romanization, not academic transliteration.
Idioms and proverbs: literal translation AND actual meaning, always.

When something is finished, close with a one-line recap: one target language,
then its English translation. Target language + English — never two target
languages, and never the target language alone.
${notes}
Ledger: ${cfg.ledger}

Due for re-surfacing (stalest first):
${dueList}

Write the ledger with these, never by editing the file — they own the format:
  P=${join(pluginRoot, "lib", "pastiche.ts")}
  bun run $P --seen "<term>"                 # used it — rotates it out
  bun run $P --mark "<term>"                 # they used it right — ✓ and rotate
  bun run $P --add <code> "<term> — <gloss>" [subject]   # new or primed item
  bun run $P --add <code> - [subject]        # ...or several, one per stdin line
  bun run $P --tag "<term>" "<subject>"      # tag a term already in the ledger
  bun run $P --correct <code> "<wrong>" "<right>" "<rule>"   # they corrected you`;
}

/** Read `languages/<code>.md` for each configured language, concatenated. */
export function loadNotes(pluginRoot: string, cfg: Config): string {
  const chunks: string[] = [];
  for (const l of cfg.languages) {
    const p = join(pluginRoot, "languages", `${l.code}.md`);
    if (!existsSync(p)) continue;
    try {
      chunks.push(readFileSync(p, "utf8").trim());
    } catch {
      /* unreadable reference file is not worth failing a session over */
    }
  }
  return chunks.length ? `\n${chunks.join("\n\n")}\n` : "";
}

/** The term itself, without its gloss — `la red` out of `la red — network`. */
export function headOf(body: string): string {
  return body.split(" — ")[0].trim();
}

/**
 * The first ledger line for the same language and the same head term, or "".
 * This is the check `text.includes(body)` cannot make: nine sessions wrote nine
 * glosses of `el registro` and each one looked new.
 */
export function sameTerm(text: string, code: string, body: string): string {
  const head = headOf(body);
  for (const e of parseLedger(text)) {
    if (e.code === code && headOf(e.term) === head) return e.line;
  }
  return "";
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const USAGE = `usage: pastiche.ts [--due <n>]
       --seen "<term>"              restamp: used it, rotate it out
       --mark "<term>"              ✓ and restamp: they used it correctly
       --add <code> "<term> — <gloss>" [subject]
       --add <code> - [subject]     read one "<term> — <gloss>" per line from stdin;
                                    one subject applies to the whole batch
       --tag "<term>" "<subject>"   set what an existing term is about
       --correct <code> "<wrong>" "<right>" "<rule>"
       --path`;

/**
 * ponytail: "not found" exits 0 per repo convention — the caller is a session
 * reading stdout, not a shell branching on $?. Only arg misuse exits 2.
 */
export function main(
  args: string[],
  cfg = loadConfig(),
  emit: (s: string) => void = s => void process.stdout.write(`${s}\n`),
  stdin: () => string = () => readFileSync(0, "utf8"),
): number {
  const flag = args[0];
  const out = (s: string) => void emit(s);
  const read = () => (existsSync(cfg.ledger) ? readFileSync(cfg.ledger, "utf8") : "");
  const usage = (): number => (process.stderr.write(`${USAGE}\n`), 2);

  const edit = (fn: typeof restamp, verb: string, arg = today()): number => {
    const needle = args[1];
    if (!needle) return usage();
    const before = read();
    if (!before) return out(`no ledger at ${cfg.ledger} — --add starts one`), 0;

    const hits = matchingLines(before, needle);
    if (!hits.length) {
      out(`no match ${JSON.stringify(needle)} in ${parseLedger(before).length} entries`);
      // Needles get built as "<script> (<romanization>)", but the ledger's
      // parenthetical carries notes, so the closing paren never lines up.
      // Retry on the leading token and show what it nearly hit.
      const head = needle.split(" ")[0];
      for (const l of (head === needle ? [] : matchingLines(before, head)).slice(0, 3)) {
        out(`  near: ${l.slice(2, 72)}`);
      }
      return 0;
    }

    const after = fn(before, needle, arg);
    if (before === after) {
      return out(`already ${arg} — ${hits.length} matched, nothing to change`), 0;
    }
    writeFileSync(cfg.ledger, after);
    const n = hits.length > 1 ? ` (${hits.length} lines)` : "";
    return out(`${verb} ${JSON.stringify(needle)} -> ${arg}${n}`), 0;
  };

  if (flag === "--path") return out(cfg.ledger), 0;
  if (flag === "--seen") return edit(restamp, "restamped");
  if (flag === "--mark") return edit(mark, "✓");
  if (flag === "--tag") return args[2] ? edit(tag, "tagged", args[2]) : usage();

  if (flag === "--add" || flag === "--correct") {
    const code = args[1];
    if (!code) return usage();
    const codes = cfg.languages.map(l => l.code);
    if (codes.length && !codes.includes(code)) {
      return out(`unknown language ${JSON.stringify(code)} — configured: ${codes.join(", ")}`), 0;
    }

    let bodies: string[];
    let marks: string | undefined;
    let subject: string | undefined;
    if (flag === "--correct") {
      // Three args rather than one composed string: if the session assembled
      // "<wrong> → <right> — <rule>" itself, the format would live in the prompt.
      // No `-` batch form — corrections arrive one at a time, unlike a session's
      // vocabulary dump.
      const [, , wrong, right, rule] = args;
      if (!wrong || !right || !rule) return usage();
      bodies = [formatCorrection(wrong, right, rule)];
      marks = "✗";
    } else {
      const body = args[2];
      if (!body) return usage();
      // `-` batches the whole session's additions into one call. Each Bash call is
      // an independent chance for the permission layer to block, so N terms added
      // one-per-call meant N chances to silently lose one; this makes it one.
      bodies = body === "-"
        ? stdin().split("\n").map(s => s.trim()).filter(Boolean)
        : [body];
      // One subject for the whole batch: a session's additions are minted from
      // one body of work, so they share its subject by construction.
      subject = args[3];
    }
    if (!bodies.length) return out("stdin empty — nothing to add"), 0;

    const before = read();
    let text = before;
    const added: string[] = [];
    const skipped: string[] = [];
    const dupes: string[] = [];
    for (const b of bodies) {
      // Exact-substring dedupe. Matching against the accumulator, not `before`,
      // also dedupes within a batch.
      if (text.includes(b)) { skipped.push(b); continue; }
      // ...and the same term under a reworded gloss, which the substring test
      // cannot see. It piled up exactly as the old comment here guessed it might:
      // 69 terms duplicated, 168 redundant lines, `el umbral` seventeen times,
      // every one of them reported as a new entry. Compare the head — the part
      // before the gloss — and hand back what is already there, so the session
      // can --mark or --tag it instead of minting a tenth copy.
      const hit = sameTerm(text, code, b);
      if (hit) { dupes.push(`${headOf(b)}\n  have: ${hit.slice(2, 96)}`); continue; }
      const line = formatEntry(code, b, today(), marks, subject);
      text = text && !text.endsWith("\n") ? `${text}\n${line}\n` : `${text}${line}\n`;
      added.push(line);
    }
    if (added.length) {
      mkdirSync(dirname(cfg.ledger), { recursive: true });
      writeFileSync(cfg.ledger, text);
    }
    for (const l of added) out(`+ ${l}`);
    for (const b of skipped) out(`exists: ${b}`);
    for (const d of dupes) out(`dupe: ${d}`);
    if (added.length) out(`(${parseLedger(before).length + added.length} entries)`);
    return 0;
  }

  if (flag && flag !== "--due") return usage();

  // Default: what's due, the same selection the hook injects.
  const text = read();
  if (!text) return out(`no ledger at ${cfg.ledger} — --add starts one`), 0;
  const n = flag === "--due" && args[1] ? Number.parseInt(args[1], 10) : cfg.due;
  if (!Number.isFinite(n)) return usage();
  const entries = parseLedger(text);
  for (const e of stalest(entries, n)) {
    out(`${e.seen}  ${e.code}: ${e.term}${e.subject ? `  [${e.subject}]` : ""}`);
  }
  const hidden = entries.length - Math.min(n, entries.length);
  if (hidden > 0) out(`+${hidden} fresher`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
