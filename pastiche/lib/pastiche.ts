#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  /**
   * The hook's surfacing counts (`recordSurfaced`). Derived from the config dir,
   * never set by the user; absent means "read none", which is what tests want.
   */
  surfaced?: string;
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
  const fallback: Config = {
    ledger: join(dir, "ledger.md"), languages: [], due: 5, fresh: 2, surfaced: join(dir, "surfaced.json"),
  };
  const path = join(dir, "config.json");
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return {
      ledger: typeof raw.ledger === "string" ? expandTilde(raw.ledger) : fallback.ledger,
      languages: Array.isArray(raw.languages) ? raw.languages : fallback.languages,
      due: Number.isFinite(raw.due) ? raw.due : fallback.due,
      fresh: Number.isFinite(raw.fresh) ? raw.fresh : fallback.fresh,
      surfaced: fallback.surfaced,
    };
  } catch {
    // Malformed config must not break the session — fall back to defaults.
    return fallback;
  }
}

// A BCP 47 shape (`km`, `yue`, `pt-BR`), because config holds whatever the user
// names a language and `--add` writes it verbatim. `--add` refuses a code this
// cannot read back, so the two cannot drift apart again.
const CODE = /^- ([a-z]{2,3}(?:-[A-Za-z0-9]+)*): /;
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
 * Stalest-first by rotation date: `seen:`, or the date the item went dormant
 * if that is later. Ties keep ledger order (Array.sort is stable), so the
 * selection is deterministic for a given file and sidecar.
 *
 * An item the session used gets today's `seen:` and drops to the back. One it
 * was shown and never used drops back after `DORMANT_AFTER` sessions instead
 * of heading the list forever — ប៉ា did, 2026-09-02 to 2026-09-24.
 */
export function stalest(entries: Entry[], n: number, surfaced: Surfaced = {}): Entry[] {
  return entries
    .map(e => ({ e, at: rotation(e, surfaced) }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, n)
    .map(x => x.e);
}

/** Sessions that may show an item without using it before it rotates to the back. */
export const DORMANT_AFTER = 3;

/**
 * Per item: the date its count started (or it last rotated), and the sessions
 * that have shown it since. Keyed by code and term, not by line, so a tag or a
 * ✓ does not reset the count; a new gloss does, which is fine.
 */
export type Surfaced = Record<string, { at: string; sessions: string[] }>;

const keyOf = (e: Entry) => `${e.code}: ${e.term}`;

function rotation(e: Entry, s: Surfaced): string {
  const at = s[keyOf(e)]?.at;
  return typeof at === "string" && at > e.seen ? at : e.seen;
}

/**
 * Count one session against each item it was shown. The item whose count
 * reaches `DORMANT_AFTER` rotates to the back, dated `date`, as if a session
 * had used it then; it comes back when everything else has rotated past it.
 *
 * Sessions, not hook runs: a compaction or resume re-fires the hook under the
 * same session_id and counts once. A `seen:` later than the record means a
 * session used the item, so the count starts over.
 *
 * ponytail: dates, not timestamps — an item used on the same day its count
 * started does not reset it. Only a ledger small enough to show an item twice
 * in one day can hit that; store timestamps if one does.
 * ponytail: never pruned. At most one record per term ever shown, so it is
 * bounded by the ledger; dead records (`at` older than `seen:`) are ignored.
 */
export function recordSurfaced(s: Surfaced, shown: Entry[], sessionId: string, date: string): Surfaced {
  const next = { ...s };
  for (const e of shown) {
    const k = keyOf(e);
    const prev = next[k];
    const rec = prev && Array.isArray(prev.sessions) && prev.at >= e.seen
      ? prev
      : { at: e.seen, sessions: [] as string[] };
    if (rec.sessions.includes(sessionId)) continue;
    const sessions = [...rec.sessions, sessionId];
    next[k] = sessions.length >= DORMANT_AFTER ? { at: date, sessions: [] } : { at: rec.at, sessions };
  }
  return next;
}

/** Missing, unreadable or malformed reads as empty: the counts are a hint, never a gate. */
export function loadSurfaced(path?: string): Surfaced {
  if (!path || !existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * The hook is the only writer. It is not the ledger: every ledger write still
 * goes through the CLI, and this file holds nothing a session should read.
 *
 * ponytail: read-modify-write with no lock. Two sessions starting in the same
 * instant can lose one count, which costs an item one more showing.
 */
export function saveSurfaced(path: string, s: Surfaced): void {
  writeAtomic(path, `${JSON.stringify(s)}\n`);
}

/** Rewrite `seen:` to `date` on every line of the term `needle` names. */
export function restamp(text: string, needle: string, date: string): string {
  return restampLines(text, matchingLines(text, needle), date);
}

/** Rewrite `seen:` to `date` on exactly `lines`: `--add`'s dupes, one language's. */
function restampLines(text: string, lines: Iterable<string>, date: string): string {
  const hit = new Set(lines);
  return text
    .split("\n")
    .map(l => (hit.has(l) ? l.replace(SEEN, `seen: ${date}`) : l))
    .join("\n");
}

/**
 * Prepend a ✓ to the marks field and restamp, on every line of the term
 * `needle` names — marking only ever happens because the item was just used.
 *
 * The marks field is optional and free text (`✓✓ family baseline`), so a line
 * without one gets it inserted before `seen:`, and a hand-written line with no
 * `seen:` at all gets both appended. Marks accumulate and are never decayed;
 * `seen:` is what drives selection.
 */
export function mark(text: string, needle: string, date: string): string {
  const hit = new Set(matchingLines(text, needle));
  return text
    .split("\n")
    .map(l => {
      if (!hit.has(l)) return l;
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
 * Set (or replace) the `subj:` tag on every line of the term `needle` names.
 *
 * It exists because the tag has to reach the ~20 items already in rotation, and
 * those lines were written before the field did. A field with no writer for the
 * lines that predate it is a field that stays empty forever.
 */
export function tag(text: string, needle: string, subject: string): string {
  const hit = new Set(matchingLines(text, needle));
  return text
    .split("\n")
    .map(l => {
      if (!hit.has(l)) return l;
      if (SUBJ.test(l)) return l.replace(SUBJ, `subj: ${subject}`);
      if (!SEEN.test(l)) return `${l} | subj: ${subject}`;
      const parts = l.split(" | ");
      return [...parts.slice(0, -1), `subj: ${subject}`, parts.at(-1)].join(" | ");
    })
    .join("\n");
}

/**
 * Every entry line of the one term `needle` names, or none. The writers above
 * rewrite exactly these, so the CLI uses it to tell "nothing matched" apart from
 * "matched, already current" — a rewrite that changes no bytes is otherwise
 * indistinguishable from a miss, and reporting it as one loses real state.
 *
 * A needle names a term (`termKey`), and all of a term's lines move together.
 * The exact term first; else a substring of exactly one term's text (`teuk`),
 * which then resolves to all of that term's lines. A substring spanning several
 * terms names none of them (`termsContaining` says which, for the report). Until
 * 2026-09-26 this was a substring of the whole line, which failed both ways: a
 * mark on `អរគុណ (arkun)` left `អរគុណ (arkun / awkun)` due, and replaying 54
 * real calls, 7 restamped 16 lines of other terms — `la red` moved
 * `la redirección` and `la redundancia` out of the due list unused.
 */
export function matchingLines(text: string, needle: string): string[] {
  const entries = parseLedger(text);
  const want = termKey(needle);
  let key: string | undefined = entries.some(e => termKey(e.term) === want) ? want : undefined;
  if (key === undefined) {
    const terms = termsContaining(entries, needle);
    if (terms.length === 1) key = terms[0];
  }
  return key === undefined ? [] : entries.filter(e => termKey(e.term) === key).map(e => e.line);
}

/** The distinct terms whose text contains `needle`, in ledger order. */
export function termsContaining(entries: Entry[], needle: string): string[] {
  return [...new Set(entries.filter(e => e.term.includes(needle)).map(e => termKey(e.term)))];
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
        `  - ${e.code}: ${e.term}${e.subject ? `  [${e.subject}]` : ""}  [last used ${e.seen}]`,
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
failure. Leave it due rather than forcing it: after ${DORMANT_AFTER} sessions without
use it moves to the back of the queue on its own. The test is the one the new-term
budget already uses: does this session's work touch the term's subject.

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
  bun run $P --add <code> "<term> — <gloss>" [subject]   # new or primed item; a repeat restamps
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
 * What makes two lines the same term: the head with any parenthetical dropped.
 * The parenthetical is a romanization or a note, and neither is the term:
 * `អរគុណ (arkun)` and `អរគុណ (arkun / awkun)` are one word, and so are
 * `តូច (toch)` and `តូច (toch; final ch unreleased)`. On 2026-09-24 three km
 * terms were split this way across 657 entries; no es term was.
 */
export function termKey(body: string): string {
  return headOf(body).split(" (")[0].trim();
}

/**
 * Every ledger line for the same language and the same term (`termKey`).
 * This is the check `text.includes(body)` cannot make: nine sessions wrote nine
 * glosses of `el registro` and each one looked new. All of them, not the first,
 * because copies have to rotate together.
 */
export function sameTerm(text: string, code: string, body: string): string[] {
  const key = termKey(body);
  return parseLedger(text)
    .filter(e => e.code === code && termKey(e.term) === key)
    .map(e => e.line);
}

/**
 * The LOCAL calendar date, not the UTC one.
 *
 * `toISOString()` rolls over at UTC midnight, which is 19:00 CDT — so an evening
 * session stamped every entry it wrote with tomorrow's date, and `seen:` drives
 * rotation, so an 8pm term outranked a 9am term that was genuinely newer.
 * Measured 2026-08-18 22:07 CDT and again 2026-09-08 23:00 CDT.
 */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Write via temp file + rename, the same way `journal-append.ts` and
 * `affirm.ts` do. Used for the ledger and the hook's sidecar. The ledger has
 * concurrent writers in practice — another
 * session appended six entries to it mid-review on 2026-09-08 — and a bare
 * `writeFileSync` can be observed truncated. This closes the truncation half;
 * the lost-update window is narrowed, not eliminated.
 */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
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
      const entries = parseLedger(before);
      const near = (terms: string[]) => {
        for (const t of terms.slice(0, 3)) {
          const e = entries.find(x => termKey(x.term) === t)!;
          out(`  near: ${e.code}: ${e.term.slice(0, 68)}`);
        }
      };
      const terms = termsContaining(entries, needle);
      if (terms.length > 1) {
        out(`ambiguous ${JSON.stringify(needle)}: ${terms.length} terms contain it — name one`);
        return near(terms), 0;
      }
      out(`no match ${JSON.stringify(needle)} in ${entries.length} entries`);
      // Retry on the leading token and show what it nearly hit.
      const head = needle.split(" ")[0];
      return near(head === needle ? [] : termsContaining(entries, head)), 0;
    }

    const after = fn(before, needle, arg);
    const n = hits.length > 1 ? ` (${hits.length} lines)` : "";
    // Worded as the success it is: the state asked for is the state on disk.
    // "nothing to change" read to sessions as a failure.
    if (before === after) return out(`already current: ${JSON.stringify(needle)} -> ${arg}${n}`), 0;
    writeAtomic(cfg.ledger, after);
    return out(`${verb} ${JSON.stringify(needle)} -> ${arg}${n}`), 0;
  };

  if (flag === "--path") return out(cfg.ledger), 0;
  if (flag === "--seen") return edit(restamp, "restamped");
  if (flag === "--mark") return edit(mark, "✓");
  if (flag === "--tag") return args[2] ? edit(tag, "tagged", args[2]) : usage();

  if (flag === "--add" || flag === "--correct") {
    const code = args[1];
    if (!code) return usage();
    // The reader decides what the writer may write. Checked before config
    // membership, because an empty `languages` skips that check entirely.
    if (parseLedger(formatEntry(code, "-", "")).at(0)?.code !== code) {
      return out(`language code ${JSON.stringify(code)} would not read back from the ledger — use a BCP 47 tag like pt or pt-BR`), 0;
    }
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
    const date = today();
    for (const b of bodies) {
      // The same term, by head — the part before the gloss — which catches a
      // reworded gloss the substring test below cannot see. It piled up as the
      // old comment here guessed: 69 terms duplicated, 168 redundant lines,
      // `el umbral` seventeen times, each reported as new. Matching against the
      // accumulator, not `before`, also dedupes within a batch.
      //
      // A hit is restamped, not refused: the session reached for the term, so it
      // was surfaced, and refusing cost 3–4 round trips to reach this same write
      // (journal, four consecutive entries 2026-09-22..23). The copy count goes
      // out with it — it is data about the ledger's shape, not noise.
      const hits = sameTerm(text, code, b);
      if (hits.length) {
        const after = restampLines(text, hits, date);
        const state = after === text ? "already" : "restamped";
        dupes.push(
          `dupe: ${headOf(b)} ×${hits.length} — ${state} ${date}`,
          `  have: ${restampLines(hits[0], hits, date).slice(2, 96)}`,
        );
        text = after;
        continue;
      }
      // The body is on disk but under no line with this language and head — a
      // gloss mention, another language — so there is no term to restamp.
      if (text.includes(b)) { skipped.push(b); continue; }
      const line = formatEntry(code, b, date, marks, subject);
      text = text && !text.endsWith("\n") ? `${text}\n${line}\n` : `${text}${line}\n`;
      added.push(line);
    }
    if (text !== before) {
      mkdirSync(dirname(cfg.ledger), { recursive: true });
      writeAtomic(cfg.ledger, text);
    }
    for (const l of added) out(`+ ${l}`);
    for (const b of skipped) out(`exists: ${b}`);
    for (const d of dupes) out(d);
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
  for (const e of stalest(entries, n, loadSurfaced(cfg.surfaced))) {
    out(`${e.seen}  ${e.code}: ${e.term}${e.subject ? `  [${e.subject}]` : ""}`);
  }
  const hidden = entries.length - Math.min(n, entries.length);
  if (hidden > 0) out(`+${hidden} fresher`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
