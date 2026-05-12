# enfurbish

Claude Code plugins.

Each plugin lives in a sibling directory at the repo root with its own manifest, README, and tests. There is no top-level manifest tying them together — each ships and installs independently.

## Plugins

### [`continuity/`](./continuity) — intentional session continuity

Closes the loop between Claude Code sessions.

- **`/wrap`** ends a session by producing a retro, a tooling-stack verdict, and a `NEXT_SESSION.md` handoff for the next time.
- **`SessionStart` hook** surfaces the handoff at the start of the next session via a `systemMessage` banner — no context dump unless you opt in.
- **`/resume`** loads the handoff on demand.

See [continuity/README.md](./continuity/README.md) for the tooling-journal format and what `/wrap` measures.

### [`affirm/`](./affirm) — approval gate for project instructions

A speed-bump against prompt injection through `CLAUDE.md` and `.claude/rules/*`.

- **`SessionStart` hook** lists project instruction files and warns on any unaffirmed or modified file.
- **`/affirm`** records SHA-256 hashes after you've reviewed.
- **`/affirm --show`** / **`--revoke`** for inspection and rollback.

See [affirm/README.md](./affirm/README.md) for the threat model and storage details.

## Development

Bun, TypeScript-native, no build step, no `package.json`. Bun's built-in test runner.

```bash
# Run all tests across all plugins
bun test

# One plugin
bun test continuity/tests/
bun test affirm/tests/
```

There is no linter or formatter configured.

## Installation

Each plugin installs separately via Claude Code's plugin mechanism. See per-plugin READMEs for the exact command.

## License

MIT. See [LICENSE](./LICENSE).
