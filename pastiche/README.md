# pastiche

Ambient language learning inside Claude Code. pastiche reads your vocabulary
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
  conversation is about, so the split should follow your life, not a curriculum. `code` is a
  BCP 47 tag: `km`, `yue`, `pt-BR`.

`languages` is the on switch. Configure at least one and the hook runs whether or not a
ledger exists yet — with no file, the first terms a session introduces start it. Copy
`ledger.example.md` to your ledger path if you would rather seed it by hand.

## The ledger

```
- km: ទឹក (teuk) — water | 2026-01-01 | ✓✓ | subj: family, food | seen: 2026-03-14
```

Language code, term, gloss, introduce date, optional marks, optional `subj:` tag,
last-used date. Everything between the gloss and `seen:` is free text — pronunciation
notes, where you heard it, who says it differently. The parser only needs the leading code
and the trailing `seen:`.

`subj:` is what the term is *about*, and it is the one field the injected prompt asks the
model to act on. A due item only fits a session whose work touches its subject; without the
tag the model re-derives that subject from the gloss every session, and measured across
seven sessions it kept re-deriving the same three — ប៉ា (dad), la tierra (electrical ground),
la valuación — into technical work they could never fit. The tag doesn't filter anything;
it hands over evidence the ledger already had. An untagged line surfaces marked `[untagged]`,
which asks the session to derive the subject and tag it. The due list, in the hook and from
`--due`, ends with how many terms are still untagged, so a backlog can be seen and worked
down. `--tag` on a term that already has a subject prints the one it replaced.

Rotation has two inputs. Sessions restamp what they use, so used items move to the back and
unused ones drift to the front. And an item the hook shows in 3 sessions that never use it
moves to the back on its own, dated that day, and comes back once everything else has rotated
past it. Without that, the few items no session had an opening for held the head of the due
list for three weeks. The hook keeps the count in `surfaced.json` beside your config, per term (a new gloss keeps it),
one entry per session, so re-injecting after a compaction counts once, and it says
`rotated to back` under the due list in the session that rotates an item. There are no
intervals and no ease factors.

Marks accumulate and are never decayed. A line with four ✓ on it is a line you have used
four times, not a claim about how well you know it now — `seen:` is what drives selection.

## Loops and the band

On Claude Code 2.1.287 or later, pastiche also loads a mod, code that runs inside Claude
Code. It does two things.

It holds the vocabulary back until the first prompt a schedule did not fire. A session
driven by `/loop` or a routine never carries the terms and never counts as having been
shown them, so a night of unattended loops does not rotate your due list. In a session you
started and then left on a loop, each scheduled turn carries one line telling the model that
nobody is reading and nothing should be written.

It draws the due terms above the prompt, in the terminal and the desktop app, for the rest
of the session. Collapse it with ctrl+x ctrl+a. Seeing a term there does not count as
using it.

Where mods do not load (an older Claude Code, or an organization that allows only its own),
the `SessionStart` hook injects the vocabulary when the session starts, as before.

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
bun run lib/pastiche.ts --add es -                 # a line ending "[concurrency]" is tagged alone
bun run lib/pastiche.ts --tag "teuk" "family, food"   # set its subject, replacing the old one
bun run lib/pastiche.ts --correct es "costa" "cuesta" "costar is o→ue, stressed forms only"
bun run lib/pastiche.ts --dedupe                   # merge each term's copies into one line
bun run lib/pastiche.ts --path                     # resolved ledger path
```

Sessions call these; they don't edit the ledger. Formatting a line, stamping today's date
into two fields, and inserting a marks field that may or may not already exist are
deterministic operations, so they belong in code where they can be tested — not in a format
string the model reassembles from memory each time. `--add` creates the file and its parent
directory on first use, rejects a language code you haven't configured or that the ledger
could not read back, and won't duplicate a term already present.

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

Dedupe matches on the *term* — the text before its gloss, with any parenthetical dropped — in
the same language, so a reworded gloss or a second romanization (`អរគុណ (arkun)` beside
`អរគុណ (arkun / awkun)`) is caught as well as an exact repeat. Measured on a real ledger before this
existed: 69 duplicated terms and 168 redundant lines, `el umbral` seventeen times, each one
reported as new. A dupe is not refused, it is **restamped**: the session reached for the term,
so it was surfaced, which is what `--seen` records. Every copy moves together and the `×N` says
how many there are. The refusal it replaced cost three or four round trips per session
(`--add`, read the existing line, `--seen`) to reach the same write. A subject passed with the
repeat tags the term if no copy is tagged (`; tagged`), and never replaces one that is
(`; kept subj: <subject>`); `--tag` is how a subject changes. `exists:` remains for the
one case with nothing to restamp: the body is in the file, but under a different language or
inside another term's gloss.

A ledger written before this has its copies still in it. `--dedupe` merges each term's copies
into the first one, which keeps its gloss and introduce date and takes the latest `seen:`, the
most marks and every copy's subject; the other glosses are dropped, so commit the ledger first
if you want them. The first gloss is the original and usually the broadest (`threshold` rather
than `the 16384-byte threshold`). Copies were harmless while they rotated together, but the
per-session dormancy count keys on the whole line, so two copies of one term could fall out of
step and take two due slots. After an `--add`, the count line shows terms beside lines whenever
the two differ.

`--seen`, `--mark` and `--tag` name a term the same way, and every line of that term moves
together. The exact term wins (`la red` moves `la red`, not `la redirección` or `la red
interna`); failing that, the term without the punctuation at its edges (`ve` names `¡ve!`,
where as a fragment it was in 91 terms); failing that, a fragment of exactly one term's text
resolves to it (`teuk`); a
fragment spanning several terms is reported as ambiguous with the candidates, and nothing is
written. Until 0.8.0 the needle was a substring of the whole line: replaying 54 real calls, 7
restamped 16 lines of *other* terms, moving them out of the due list unused, and a mark on
`អរគុណ (arkun)` left its `(arkun / awkun)` copy due. A needle may also lead with its language, as every due line does: `--seen "es: la red — network"` resolves to `la red` in Spanish only, so a due line pasted back whole works.

A batch's one subject tags every line it adds, and every repeat it restamps that has no
subject yet. A line that ends in brackets, `el hilo — thread [concurrency]`, the shape the due
list prints, takes that subject instead: one batch subject once tagged a repeat with the
subject meant for the line after it.

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
