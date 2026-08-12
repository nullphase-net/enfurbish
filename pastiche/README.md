# pastiche

Ambient language learning inside Claude Code. A `SessionStart` hook reads your vocabulary
ledger, picks the items you have gone longest without seeing, and asks the session to weave
them into ordinary work — a few terms tied to whatever you are actually doing, plus a
bilingual recap when something finishes.

No lessons, no quizzing, no flashcard session to schedule. You do your work; the language
arrives in the margins of it.

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
  "languages": [
    { "code": "km", "name": "Khmer",   "domains": "everyday, family, food, feelings" },
    { "code": "es", "name": "Spanish", "domains": "technical, abstract" }
  ]
}
```

- `ledger` — path to your ledger. Point it anywhere; a git repo is a good home, since the
  ledger is the only thing here worth keeping.
- `due` — how many stale items to surface per session. 5 is a drip; 20 is a lesson.
- `languages` — `domains` is the routing rule. The session picks a language by what the
  conversation is about, so the split should follow your life, not a curriculum.

Then copy `ledger.example.md` to your ledger path and start adding lines. No ledger means
the hook emits nothing at all — the plugin is inert until you feed it.

## The ledger

```
- km: ទឹក (teuk) — water | 2026-01-01 | ✓✓ | seen: 2026-03-14
```

Language code, term, gloss, introduce date, optional marks, last-surfaced date. Everything
between the gloss and `seen:` is free text — pronunciation notes, where you heard it, who
says it differently. The parser only needs the leading code and the trailing `seen:`.

`seen:` is the whole mechanism. Sessions restamp what they use, so used items rotate to the
back and unused ones drift to the front. There are no intervals and no ease factors — an
item you never reinforce simply keeps coming back, which is the behavior you wanted anyway.

## Commands

```bash
bun run lib/pastiche.ts                 # what's due now
bun run lib/pastiche.ts --due 10        # ...but ten of them
bun run lib/pastiche.ts --seen "teuk"   # restamp a term to today
bun run lib/pastiche.ts --path          # resolved ledger path
```

## Language notes

`languages/<code>.md` ships phonology and convention notes that get injected alongside the
due list — how to romanize, which contrasts English ears miss, what to write when a native
speaker and the reference disagree. Khmer and Spanish are included. Adding a language is one
file; it is read by code, not compiled in.

<!-- ponytail: no /setup command — the config is three keys and hand-editing JSON is fine.
     Add one if people actually get it wrong. -->
