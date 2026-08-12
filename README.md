# enfurbish

Claude Code plugins.

Each plugin lives in a sibling directory at the repo root with its own manifest, README, and tests. There is no top-level manifest tying them together — each ships and installs independently.

## Plugins

### [`continuity/`](./continuity) — intentional session continuity

Closes the loop between Claude Code sessions.

- **`/wrap`** ends a session by producing a retro, a tooling-stack verdict, and a `NEXT_SESSION.md` handoff for the next time.
- **`SessionStart` hook** surfaces the handoff at the start of the next session via a `systemMessage` banner — no context dump unless you opt in.
- **`/next`** loads the handoff on demand.

See [continuity/README.md](./continuity/README.md) for the tooling-journal format and what `/wrap` measures.

### [`affirm/`](./affirm) — approval gate for project instructions

A speed-bump against prompt injection through `CLAUDE.md` and `.claude/rules/*`.

- **`SessionStart` hook** lists project instruction files and warns on any unaffirmed or modified file.
- **`/affirm`** shows what's in scope with status, mtime, and git provenance.
- **`/affirm -a`** records SHA-256 hashes after you've reviewed; **`-r`** revokes.

See [affirm/README.md](./affirm/README.md) for the threat model and storage details.

### [`pastiche/`](./pastiche) — ambient language learning

Vocabulary in the margins of ordinary work, rather than a study session you have to schedule.

- **`SessionStart` hook** injects the items you've gone longest without seeing, plus how to
  present them, as `additionalContext`.
- **Three ways in.** Reinforcement of stale items, a small per-session budget of new terms
  drawn from whatever you're working on, and priming — a term you use yourself gets recorded
  instead of taught back at you.
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

Each plugin installs separately via Claude Code's plugin mechanism. See per-plugin READMEs for the exact command.

## License

MIT. See [LICENSE](./LICENSE).
