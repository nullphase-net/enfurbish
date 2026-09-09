# enfurbish

Claude Code plugins.

Each plugin lives in a sibling directory at the repo root with its own manifest, README, and tests. There is no top-level manifest tying them together — each ships and installs independently.

## Plugins

### [`continuity/`](./continuity) — intentional session continuity

Closes the loop between Claude Code sessions.

- **`/wrap`** ends a session by producing a retro, a tooling-stack verdict, and a `NEXT_SESSION.md` handoff for the next time.
- **`SessionStart` hook** surfaces the handoff at the start of the next session via a `systemMessage` banner — no context dump unless you opt in.
- **`/next`** loads the handoff on demand.
- **Staleness evidence.** `handoffs.ts --since` reports what landed after a handoff was written — the commits, the files they touched, and how much is still uncommitted — so a session that ended without a wrap doesn't leave the next one re-triaging threads that are already done.

See [continuity/README.md](./continuity/README.md) for the tooling-journal format and what `/wrap` measures.

### [`affirm/`](./affirm) — approval gate for project instructions

A speed-bump against prompt injection through `CLAUDE.md`, `.claude/rules/*`, and the files those reach via `@import` (followed two levels deep; imports pointing outside the project are hashed and flagged).

- **`SessionStart` hook** lists project instruction files and warns on any unaffirmed or modified file.
- **`/affirm`** shows what's in scope with status, mtime, and git provenance.
- **`/affirm -a`** records SHA-256 hashes after you've reviewed; **`-r`** revokes.
- **`--since <iso>`** lists only what moved inside a window. `continuity`'s `/wrap` runs it with the session's start time, so a change you made yourself is summarized at the end of that session rather than surfacing as a trust warning at the start of the next one.

See [affirm/README.md](./affirm/README.md) for the threat model and storage details.

### [`pastiche/`](./pastiche) — ambient language learning

Vocabulary in the margins of ordinary work, rather than a study session you have to schedule.

- **`SessionStart` hook** injects the items you've gone longest without seeing, plus how to
  present them, as `additionalContext`.
- **Four ways in.** Reinforcement of stale items, a small per-session budget of new terms
  drawn from whatever you're working on, priming — a term you use yourself gets recorded
  instead of taught back at you — and correction, when you fix a form the session got wrong.
- **A markdown ledger** you own and point at from config — one line per term, a `seen:` date
  that sessions restamp as they use things. A CLI writes it; the model calls the CLI.
- **No intervals, no ease factors.** Used items rotate to the back; unreinforced ones keep
  coming back.

See [pastiche/README.md](./pastiche/README.md) for the ledger format and config.

## Development

Bun, TypeScript-native, no build step, no `package.json`. Bun's built-in test runner.

```bash
# Run all tests across all plugins
bun test

# One plugin
bun test continuity/tests/
bun test affirm/tests/
bun test pastiche/tests/
```

There is no linter or formatter configured.

## Installation

```
/plugin marketplace add nullphase-net/enfurbish
/plugin install continuity@enfurbish
/plugin install affirm@enfurbish
/plugin install pastiche@enfurbish
```

Each installs independently — take one, two, or all three. Per-plugin READMEs cover setup and configuration.

## License

MIT. See [LICENSE](./LICENSE).
