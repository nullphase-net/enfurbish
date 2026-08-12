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

After using an item, restamp it so it rotates out:
  bun run ${join(pluginRoot, "lib", "pastiche.ts")} --seen "<term>"
Append a new or primed item: \`- <code>: <term> — <gloss> | <today> | seen: <today>\``;
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const flag = args[0];

  if (flag === "--path") {
    process.stdout.write(`${cfg.ledger}\n`);
  } else if (flag === "--seen") {
    const needle = args[1];
    if (!needle) {
      process.stderr.write("usage: pastiche.ts --seen <term-substring>\n");
      process.exit(2);
    }
    if (!existsSync(cfg.ledger)) {
      process.stderr.write(`no ledger at ${cfg.ledger}\n`);
      process.exit(1);
    }
    const before = readFileSync(cfg.ledger, "utf8");
    const after = restamp(before, needle, today());
    if (before === after) {
      process.stderr.write(`no ledger line matched ${JSON.stringify(needle)}\n`);
      process.exit(1);
    }
    writeFileSync(cfg.ledger, after);
    process.stdout.write(`restamped ${JSON.stringify(needle)} -> ${today()}\n`);
  } else {
    // Default: print what's due, the same selection the hook injects.
    if (!existsSync(cfg.ledger)) {
      mkdirSync(dirname(cfg.ledger), { recursive: true });
      process.stderr.write(`no ledger at ${cfg.ledger}\n`);
      process.exit(1);
    }
    const n = flag === "--due" && args[1] ? Number.parseInt(args[1], 10) : cfg.due;
    const due = stalest(parseLedger(readFileSync(cfg.ledger, "utf8")), n);
    for (const e of due) process.stdout.write(`${e.seen}  ${e.code}: ${e.term}\n`);
  }
}
