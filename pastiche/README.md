# pastiche

Ambient language learning inside Claude Code. A `SessionStart` hook reads your vocabulary
ledger, picks the items you have gone longest without seeing, and asks the session to weave
them into ordinary work — a few terms tied to whatever you are actually doing, plus a recap
in the target language with its English translation when something finishes.

No lessons, no quizzing, no flashcard session to schedule. You do your work; the language
arrives in the margins of it.

Vocabulary enters three ways: **reinforcement** of stale items from the ledger, a small
budget of **new** terms the session draws from whatever you are working on, and **priming** —
a term you drop into a prompt yourself gets recorded rather than taught back at you.

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
- km: ទឹក (teuk) — water | 2026-01-01 | ✓✓ | seen: 2026-03-14
```

Language code, term, gloss, introduce date, optional marks, last-surfaced date. Everything
between the gloss and `seen:` is free text — pronunciation notes, where you heard it, who
says it differently. The parser only needs the leading code and the trailing `seen:`.

`seen:` is the whole rotation mechanism. Sessions restamp what they use, so used items move
to the back and unused ones drift to the front. There are no intervals and no ease factors:
an item you never reinforce keeps coming back until something restamps it.

Marks accumulate and are never decayed. A line with four ✓ on it is a line you have used
four times, not a claim about how well you know it now — `seen:` is what drives selection.

## Commands

```bash
bun run lib/pastiche.ts                            # what's due now
bun run lib/pastiche.ts --due 10                   # ...but ten of them
bun run lib/pastiche.ts --seen "teuk"              # used it — restamp to today
bun run lib/pastiche.ts --mark "teuk"              # used it right — ✓ and restamp
bun run lib/pastiche.ts --add km "ទឹក (teuk) — water"
bun run lib/pastiche.ts --path                     # resolved ledger path
```

Sessions call these; they don't edit the ledger. Formatting a line, stamping today's date
into two fields, and inserting a marks field that may or may not already exist are
deterministic operations, so they belong in code where they can be tested — not in a format
string the model reassembles from memory each time. `--add` creates the file and its parent
directory on first use, rejects a language code you haven't configured, and won't duplicate
a term already present.

Not-found exits 0 and says so on stdout; only misusing a flag exits 2. The caller is a
session reading output, not a shell branching on `$?`.

## Language notes

`languages/<code>.md` ships phonology and convention notes that get injected alongside the
due list — how to romanize, which contrasts English ears miss, what to write when a native
speaker and the reference disagree. Khmer and Spanish are included. Adding a language is one
file; it is read by code, not compiled in.

<!-- ponytail: no /setup command — the config is three keys and hand-editing JSON is fine.
     Add one if people actually get it wrong. -->
