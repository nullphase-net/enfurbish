# pastiche

Ambient language learning inside Claude Code. A `SessionStart` hook reads your vocabulary
ledger, picks the items you have gone longest without seeing, and asks the session to weave
them into ordinary work — a few terms tied to whatever you are actually doing, plus a recap
in the target language with its English translation when something finishes.

No lessons, no quizzing, no flashcard session to schedule. You do your work; the language
arrives in the margins of it.

Vocabulary enters four ways: **reinforcement** of stale items from the ledger, a small
budget of **new** terms the session draws from whatever you are working on, **priming** —
a term you drop into a prompt yourself gets recorded rather than taught back at you — and
**correction**, when you fix a form the session got wrong.

## Install

```
/plugin marketplace add nullphase-net/enfurbish
/plugin install pastiche@enfurbish
```

## Setup

Write `~/.claude/pastiche/config.json`:

```json
{
  "ledger": "~/.claude/pastiche/ledger.md",
  "due": 5,
  "fresh": 2,
  "languages": [
    { "code": "km", "name": "Khmer",   "domains": "everyday, family, food, feelings" },
    { "code": "es", "name": "Spanish", "domains": "technical, abstract" }
  ]
}
```

- `ledger` — path to your ledger. Point it anywhere; a git repo is a good home, since the
  ledger is the only thing here worth keeping.
- `due` — how many stale items to surface per session. 5 is a drip; 20 is a lesson.
- `fresh` — how many *new* terms to introduce per session. Separate budget from `due`, so a
  long ledger can't starve intake. Set it to `0` for reinforcement only.
- `languages` — `domains` is the routing rule. The session picks a language by what the
  conversation is about, so the split should follow your life, not a curriculum.

`languages` is the on switch. Configure at least one and the hook runs whether or not a
ledger exists yet — with no file, the first terms a session introduces start it. Copy
`ledger.example.md` to your ledger path if you would rather seed it by hand.

## The ledger

```
- km: ទឹក (teuk) — water | 2026-01-01 | ✓✓ | subj: family, food | seen: 2026-03-14
```

Language code, term, gloss, introduce date, optional marks, optional `subj:` tag,
last-surfaced date. Everything between the gloss and `seen:` is free text — pronunciation
notes, where you heard it, who says it differently. The parser only needs the leading code
and the trailing `seen:`.

`subj:` is what the term is *about*, and it is the one field the injected prompt asks the
model to act on. A due item only fits a session whose work touches its subject; without the
tag the model re-derives that subject from the gloss every session, and measured across
seven sessions it kept re-deriving the same three — ប៉ា (dad), la tierra (electrical ground),
la valuación — into technical work they could never fit. The tag doesn't filter anything;
it hands over evidence the ledger already had. Untagged lines surface exactly as before.

`seen:` is the whole rotation mechanism. Sessions restamp what they use, so used items move
to the back and unused ones drift to the front. There are no intervals and no ease factors:
an item you never reinforce keeps coming back until something restamps it.

Marks accumulate and are never decayed. A line with four ✓ on it is a line you have used
four times, not a claim about how well you know it now — `seen:` is what drives selection.

## Commands

Paths are relative to the plugin root — `~/.claude/plugins/cache/enfurbish/pastiche/<version>/`
when installed, or `pastiche/` in a checkout.

```bash
bun run lib/pastiche.ts                            # what's due now
bun run lib/pastiche.ts --due 10                   # ...but ten of them
bun run lib/pastiche.ts --seen "teuk"              # used it — restamp to today
bun run lib/pastiche.ts --mark "teuk"              # used it right — ✓ and restamp
bun run lib/pastiche.ts --add km "ទឹក (teuk) — water" "family, food"
bun run lib/pastiche.ts --add km - "rf, hardware"  # ...or several, one per stdin line
bun run lib/pastiche.ts --tag "teuk" "family, food"   # tag something already there
bun run lib/pastiche.ts --correct es "costa" "cuesta" "costar is o→ue, stressed forms only"
bun run lib/pastiche.ts --path                     # resolved ledger path
```

Sessions call these; they don't edit the ledger. Formatting a line, stamping today's date
into two fields, and inserting a marks field that may or may not already exist are
deterministic operations, so they belong in code where they can be tested — not in a format
string the model reassembles from memory each time. `--add` creates the file and its parent
directory on first use, rejects a language code you haven't configured, and won't duplicate
a term already present.

`--add <code> -` batches a whole session's additions into one call. Each `Bash` call is an
independent chance for the permission layer to block, so adding N terms one-per-call meant N
chances to silently lose one — a real occurrence, logged before this existed. The batch
dedupes against the ledger and within itself, reports every skip, and writes once:

```
$ printf 'la red — network\nel hilo — thread\n' | bun run lib/pastiche.ts --add es -
+ - es: el hilo — thread | 2026-09-23 | seen: 2026-09-23
dupe: la red ×1 — restamped 2026-09-23
  have: es: la red — network | 2026-08-11 | seen: 2026-09-23
(2 entries)
```

Dedupe matches on the *head* — the term before its gloss — in the same language, so a
reworded gloss is caught as well as an exact repeat. Measured on a real ledger before this
existed: 69 duplicated terms and 168 redundant lines, `el umbral` seventeen times, each one
reported as new. A dupe is not refused, it is **restamped**: the session reached for the term,
so it was surfaced, which is what `--seen` records. Every copy moves together and the `×N` says
how many there are. The refusal it replaced cost three or four round trips per session
(`--add`, read the existing line, `--seen`) to reach the same write. `exists:` remains for the
one case with nothing to restamp: the body is in the file, but under a different language or
inside another term's gloss.

Bare `--add <code>` with no body is still arg misuse (exit 2), not a blocking read on a tty —
the `-` is required to ask for stdin.

## Corrections

When someone corrects the session — a wrong ending, a bad tense, a form that isn't a word —
that's the highest-value signal this thing gets, and it isn't vocabulary. `--correct` records
it as an entry marked `✗`, keeping the wrong form next to the right one:

```
$ bun run lib/pastiche.ts --correct es "costa" "cuesta" "costar is o→ue, stressed forms only"
+ - es: costa → cuesta — costar is o→ue, stressed forms only | 2026-08-19 | ✗ | seen: 2026-08-19
```

The wrong form is kept deliberately: it's the half that predicts the next mistake. A
correction then rotates like any other entry, and `--mark` on it once you get it right reads
`✓✗` — wrong once, right since.

Three separate arguments rather than one composed string, for the same reason the rest of the
CLI exists: if the session assembled `<wrong> → <right> — <rule>` itself, the format would
live in a prompt and drift.

Not-found exits 0 and says so on stdout; only misusing a flag exits 2. The caller is a
session reading output, not a shell branching on `$?`.

## Language notes

`languages/<code>.md` ships phonology and convention notes that get injected alongside the
due list — how to romanize, which contrasts English ears miss, what to write when a native
speaker and the reference disagree. Khmer and Spanish are included. Adding a language is one
file; it is read by code, not compiled in.

These files hold invariant facts about the language, so they ship with the plugin and nothing
writes to them at runtime. Anything true about *you* — including a correction — goes in the
ledger instead, where it rotates and where a plugin update can't overwrite it.

<!-- ponytail: no /setup command — the config is three keys and hand-editing JSON is fine.
     Add one if people actually get it wrong. -->
