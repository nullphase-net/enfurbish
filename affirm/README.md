# affirm

An approval gate for project instructions.

Every time a Claude Code session starts in a project with a `CLAUDE.md` or `.claude/rules/*`, those files are loaded as system instructions — they shape Claude's behavior for the entire session. A malicious commit, a compromised dependency that drops one in, or even an accidental edit can re-program Claude silently.

`affirm` makes that trust explicit. At session start it lists the project's instruction files and marks each as affirmed, new, or changed. If anything is new or changed, you review the file and run `/affirm` to record its hash. Until you do, the warning persists on every session start.

## How it works

- **SessionStart hook** computes SHA-256 of `<cwd>/CLAUDE.md` and every file under `<cwd>/.claude/rules/`, compares to hashes stored in `~/.claude/affirm-hashes.json`, and emits a `systemMessage` banner. The banner is the only output — instruction content is never injected into Claude's context.
- **`/affirm` skill** wraps a small CLI that records, shows, or revokes hashes for the current cwd.

## Banner format

```
Affirm: instruction files in this project:
  ✓ CLAUDE.md
  ✦ .claude/rules/style.md  [NEW — unaffirmed]
  ✧ .claude/rules/security.md  [CHANGED — unaffirmed]

⚠ Review unaffirmed files, then run /affirm.
```

| Marker | Meaning |
|---|---|
| `✓` | Hash matches the affirmed value — trusted. |
| `✦` | No record of this file — never affirmed. |
| `✧` | Hash differs from the affirmed value — content changed. |

When everything is affirmed the banner shows only `✓` lines and no warning.

## Commands

### `/affirm`

Read-only. Shows each instruction file in the current cwd with its affirmation status, modification time, and git info (last commit author + date, and whether there are uncommitted local changes).

### `/affirm -a` (or `--apply`)

Records SHA-256 hashes for every `CLAUDE.md` / `.claude/rules/*` file in the current cwd to `~/.claude/affirm-hashes.json`. Invoking `-a` is itself the attestation — there's no separate "are you sure?" prompt.

### `/affirm -r` (or `--revoke`)

Removes affirmation records for the current cwd. The next session will surface those files as `NEW`. Useful for forcing yourself to re-review.

## Direct CLI use

If you don't want to go through the skill, run the CLI from a shell in the project root:

```bash
bun run <plugin-root>/lib/cli.ts          # show details
bun run <plugin-root>/lib/cli.ts -a       # record hashes
bun run <plugin-root>/lib/cli.ts -r       # revoke
```

## Scope and threat model

**In scope:**

- `<cwd>/CLAUDE.md`
- Every file under `<cwd>/.claude/rules/` (recursive, symlinks skipped to avoid following malicious links out of the tree)

**Out of scope:**

- `~/.claude/CLAUDE.md` — user-global instructions. You control your own dotfiles; tracking them here would mostly produce noise.
- Nested `CLAUDE.md` files in subdirectories of the project. Add this if you have a multi-package repo where each package ships its own CLAUDE.md — file an issue.
- Files referenced *by* CLAUDE.md (e.g., a CLAUDE.md that says "also read `docs/conventions.md`"). The reference graph is unbounded; the user is expected to review what they're affirming.

This is a *speed-bump* against prompt injection, not a guarantee. It catches:

- A malicious branch merging changes to CLAUDE.md.
- A dependency or scaffolding tool dropping a CLAUDE.md or `.claude/rules/*` into your project.
- An accidental edit you forgot you made.

It does NOT catch:

- Prompt injection arriving via files Claude reads during the session.
- Tools or MCP servers acting maliciously after being trusted.
- Anyone with write access to `~/.claude/affirm-hashes.json` itself.

## Storage

Hashes live at `~/.claude/affirm-hashes.json`:

```json
{
  "/path/to/projectA/CLAUDE.md": "abc4fd38…",
  "/path/to/projectB/.claude/rules/style.md": "9f1a2b…"
}
```

Absolute paths so the same project on different machines re-affirms independently. The file is written atomically (temp + rename).

## Installation

```
/plugin marketplace add nullphase-net/enfurbish
/plugin install affirm@enfurbish
```

Once installed:

- `/affirm` appears as a slash command.
- The SessionStart hook fires automatically. The first session in any project will surface every instruction file as `NEW` — review, then `/affirm`.

**Settings-watcher caveat:** if you install the hook into `~/.claude/settings.json` while a Claude Code session is already running, the hook won't fire in that session. Start a fresh `claude` process to pick it up.

## Requirements

- [Bun](https://bun.sh) on `PATH` — the lib scripts and hook are TypeScript run directly via `bun run`.
- A Claude Code installation that supports plugins.

## License

MIT.
