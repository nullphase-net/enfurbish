# Ledger

One line per item, newest last. Add ✓ when the learner uses it correctly, unprompted.
`seen:` is the last date the item was surfaced — restamp it whenever you use the item, and
pull re-surfacing candidates from the stalest end.

Stalest first: `awk -F'seen: ' '/^- /{print $2, $0}' ledger.md | sort | head`

Format: `- <code>: <term> — <gloss> | <introduced> | [marks] | seen: <date>`
Anything after the gloss is free text — pronunciation notes, usage warnings, where you heard
it. The parser only needs the leading code and the trailing `seen:`.

- km: ទឹក (teuk) — water | 2026-01-01 | seen: 2026-01-01
- es: la red — network (also "the net"; red social = social network) | 2026-01-01 | ✓ | seen: 2026-01-01
