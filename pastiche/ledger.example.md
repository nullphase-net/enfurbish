# Ledger

One line per item, newest last. Sessions write this file through the CLI rather than editing
it — `--add` appends, `--seen` restamps an item that was used, `--mark` adds a ✓ and
restamps. `bun run lib/pastiche.ts` prints what's due.

`seen:` is the last date the item was surfaced, and the only thing that drives selection:
re-surfacing candidates come from the stalest end, so an item nothing restamps keeps coming
back. Marks accumulate and are never decayed — four ✓ means you used it four times, not that
you know it four times as well.

Format: `- <code>: <term> — <gloss> | <introduced> | [marks] | seen: <date>`
Anything after the gloss is free text — pronunciation notes, usage warnings, where you heard
it. The parser only needs the leading code and the trailing `seen:`, so seeding a few lines
by hand is fine; the CLI owns the format after that.

- km: ទឹក (teuk) — water | 2026-01-01 | seen: 2026-01-01
- es: la red — network (also "the net"; red social = social network) | 2026-01-01 | ✓ | seen: 2026-01-01
