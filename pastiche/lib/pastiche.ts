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

/**
 * Parse ledger lines of the shape:
 *   `- km: ទឹក (teuk) — water | 2026-08-05 | ✓✓ | seen: 2026-08-12`
 * The marks field is optional. A line with no `seen:` falls back to its
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
      if (head.length >= 3) head[2] = `✓${head[2]}`;
      else head.push("✓");
      return [...head, `seen: ${date}`].join(" | ");
    })
    .join("\n");
}

/** Render a ledger line. The only place the on-disk format is written. */
export function formatEntry(code: string, body: string, date: string): string {
  return `- ${code}: ${body} | ${date} | seen: ${date}`;
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
    ? due.map(e => `  - ${e.code}: ${e.term}  [last surfaced ${e.seen}]`).join("\n")
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
${freshRule}
When the learner uses a term themselves, unprompted, they are priming you:
- Already in the ledger → append a ✓ to its line and restamp it.
- Not in the ledger → they already have it. Append it with a ✓. Confirm or
  correct in a clause and move on; never teach it back at them.

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
  bun run $P --add <code> "<term> — <gloss>" # new or primed item`;
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

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const USAGE = `usage: pastiche.ts [--due <n>]
       --seen "<term>"              restamp: used it, rotate it out
       --mark "<term>"              ✓ and restamp: they used it correctly
       --add <code> "<term> — <gloss>"
       --path`;

/**
 * ponytail: "not found" exits 0 per repo convention — the caller is a session
 * reading stdout, not a shell branching on $?. Only arg misuse exits 2.
 */
export function main(args: string[], cfg = loadConfig()): number {
  const flag = args[0];
  const out = (s: string) => void process.stdout.write(`${s}\n`);
  const read = () => (existsSync(cfg.ledger) ? readFileSync(cfg.ledger, "utf8") : "");
  const usage = (): number => (process.stderr.write(`${USAGE}\n`), 2);

  const edit = (fn: typeof restamp, verb: string): number => {
    const needle = args[1];
    if (!needle) return usage();
    const before = read();
    if (!before) return out(`no ledger at ${cfg.ledger} — --add starts one`), 0;
    const after = fn(before, needle, today());
    if (before === after) {
      return out(`no match ${JSON.stringify(needle)} in ${parseLedger(before).length} entries`), 0;
    }
    writeFileSync(cfg.ledger, after);
    return out(`${verb} ${JSON.stringify(needle)} -> ${today()}`), 0;
  };

  if (flag === "--path") return out(cfg.ledger), 0;
  if (flag === "--seen") return edit(restamp, "restamped");
  if (flag === "--mark") return edit(mark, "✓");

  if (flag === "--add") {
    const [, code, body] = args;
    if (!code || !body) return usage();
    const codes = cfg.languages.map(l => l.code);
    if (codes.length && !codes.includes(code)) {
      return out(`unknown language ${JSON.stringify(code)} — configured: ${codes.join(", ")}`), 0;
    }
    const before = read();
    // ponytail: exact-substring dedupe. A reworded gloss slips through; --mark
    // is the fix when it does. Fuzzy matching if duplicates actually pile up.
    if (before.includes(body)) return out(`exists: ${body}`), 0;
    mkdirSync(dirname(cfg.ledger), { recursive: true });
    const line = formatEntry(code, body, today());
    writeFileSync(cfg.ledger, before && !before.endsWith("\n") ? `${before}\n${line}\n` : `${before}${line}\n`);
    return out(`+ ${line}  (${parseLedger(before).length + 1} entries)`), 0;
  }

  if (flag && flag !== "--due") return usage();

  // Default: what's due, the same selection the hook injects.
  const text = read();
  if (!text) return out(`no ledger at ${cfg.ledger} — --add starts one`), 0;
  const n = flag === "--due" && args[1] ? Number.parseInt(args[1], 10) : cfg.due;
  if (!Number.isFinite(n)) return usage();
  const entries = parseLedger(text);
  for (const e of stalest(entries, n)) out(`${e.seen}  ${e.code}: ${e.term}`);
  const hidden = entries.length - Math.min(n, entries.length);
  if (hidden > 0) out(`+${hidden} fresher`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
