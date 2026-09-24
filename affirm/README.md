# affirm

An approval gate for project instructions.

Every time a Claude Code session starts, the project's `CLAUDE.md` and `.claude/rules/*` are loaded as system instructions — and so are the user-global ones under `~/.claude/`. They shape Claude's behavior for the entire session. A malicious commit, a compromised dependency that drops one in, an agent that edits your global config, or even an accidental edit can re-program Claude silently.

`affirm` makes that trust explicit. At session start it lists the project's instruction files and marks each as affirmed, new, or changed. If anything is new or changed, you review the file and run `/affirm` to record its hash. Until you do, the warning persists on every session start.

## How it works

- **SessionStart hook** computes SHA-256 of `<cwd>/CLAUDE.md`, every file under `<cwd>/.claude/rules/`, the same two under `~/.claude/`, and any files they `@import` (followed two levels deep; out-of-tree imports are hashed and flagged), compares to hashes stored in `~/.claude/affirm-hashes.json`, and emits a banner on both channels: `systemMessage` for the terminal and `additionalContext` for the model, so a session knows when it is running under unaffirmed instructions. The model's copy swaps the call to action for a guard: affirming is the user's attestation, not something to do on their behalf. New/changed files carry their last-modified age and git info inline so you can judge a change at a glance. The banner is the only thing injected — instruction content never is. The hook also dedupes re-fires per `session_id` (markers at `~/.claude/state/affirm-firstfire/`, pruned after 7 days) so Claude Code's multi-fire lifecycle (startup, resume, /clear, /compact) doesn't surface the banner ten times in one session.
- **`/affirm` skill** wraps a small CLI that records or shows hashes for everything in scope.
- **Global files stay quiet while they match.** `~/.claude/CLAUDE.md` is identical in every project, so a `✓` line for it would be repetition in every banner you ever see. It is hashed and watched like anything else, but it only appears when it is new or changed — which is the one time you need to know.

## Banner format

```
Affirm: instruction files in scope:
  ✓ CLAUDE.md
  ✓ ~/.claude/shared.md ← @from CLAUDE.md (out-of-tree)
  ✦ .claude/rules/style.md  [NEW — unaffirmed]
      modified 3d ago
  ✧ .claude/rules/security.md ← @from CLAUDE.md  [CHANGED — unaffirmed]
      modified 12m ago · Alice, 2026-06-20T09:12:00-05:00 (uncommitted)
  ✧ ~/.claude/CLAUDE.md (global)  [CHANGED — unaffirmed]
      modified 40m ago · untracked (uncommitted)

⚠ Review unaffirmed files, then run /affirm.
ℹ 1 @import beyond depth 2 not tracked: docs/a.md → docs/b.md
```

| Marker | Meaning |
|---|---|
| `✓` | Hash matches the affirmed value — trusted. |
| `✦` | No record of this file — never affirmed. |
| `✧` | Hash differs from the affirmed value — content changed. |
| `?` | Could not be read, so could not be hashed. Listed rather than dropped; `/affirm -a` affirms everything readable beside it and names it. |

`← @from <file>` marks a file pulled in by another's `@import`; `(global)` marks one loaded from `~/.claude/` in every project; `(out-of-tree)` marks one that lives outside the project. New/changed files get a second line with their modified age and git info — that's where it helps you judge whether a change is yours or a surprise. When everything is affirmed the banner shows only the project's `✓` lines and no warning; a project with no instruction files of its own and all globals affirmed gets no banner at all. A trailing `ℹ` line summarizes any `@imports` deeper than two levels, which are reported but not hashed.

## Commands

### `/affirm`

Read-only. Shows each instruction file in the current cwd with its affirmation status, modification time, and git info (last commit author + date, and whether there are uncommitted local changes). `@import`ed files are listed too, annotated with the file that pulled them in, their depth, and an `out-of-tree` marker when they live outside the project.

### `/affirm -a` (or `--apply`)

Records SHA-256 hashes for everything in scope — the current cwd's files and the global ones — to `~/.claude/affirm-hashes.json`. Invoking `-a` is itself the attestation; there's no separate "are you sure?" prompt. Because the store is keyed by absolute path, affirming the global file once covers every project.

### Un-affirming

There is no revoke flag. `~/.claude/affirm-hashes.json` is plain JSON keyed by absolute path; delete the line for the file you want to re-review. Removed in 0.6.0 — it was never used in practice and it was untargeted, which got actively dangerous once one entry in the store was shared by every project.

## Direct CLI use

If you don't want to go through the skill, run the CLI from a shell in the project root:

```bash
bun run <plugin-root>/lib/cli.ts          # show details
bun run <plugin-root>/lib/cli.ts -a       # record hashes
bun run <plugin-root>/lib/cli.ts --since 2026-09-08T18:00:00Z   # what moved in a window
```

`--since <iso>` lists only the tracked files whose mtime falls after the timestamp, each with its status and the subjects of any commits that touched it in that window. A file with no such commits says why: `no commits in window` only when git tracks it, otherwise `untracked`, `untracked (gitignored)` or `not in a git repo` — a gitignored `CLAUDE.md` never has commits, and saying so reads as reassurance. `continuity`'s `/wrap` runs it with the session's start time, so a change you made yourself gets summarized at the end of the session that made it rather than surfacing as a trust warning at the start of the next one. A file that was touched but still hash-matches is listed with no call to action — prompting there is the alert fatigue the gate exists to prevent.

## Scope and threat model

**In scope:**

- `<cwd>/CLAUDE.md`
- Every file under `<cwd>/.claude/rules/`, recursive, following symlinks to files and directories the way Claude Code's loader does. A linked file is hashed and shown at its real path, flagged `out-of-tree` when it lives elsewhere. Skipping links, as versions before 0.7.0 did, did not stop Claude Code from loading them; it only stopped anyone from watching them.
- `~/.claude/CLAUDE.md` and every file under `~/.claude/rules/`, collected the same way. These load in every session regardless of project, and sessions now routinely edit them, so leaving them untracked was the larger hole. Set `AFFIRM_GLOBAL_DIR` to point the global root somewhere else.
- Files any of those reach via Claude Code's `@import` syntax, followed two levels deep. Imports are resolved relative to the importing file (with `~/` and absolute paths supported) and skipped inside code spans/blocks, matching Claude Code. An import that points outside the project is still hashed, just flagged `out-of-tree`. Imports deeper than two levels are reported in the banner but not hashed — depth is capped to keep an unbounded graph from quietly pulling in the world.

**Out of scope:**

- `~/.claude/settings.json`, hooks, and skills. Those execute rather than instruct; hashing them is a different job.
- Nested `CLAUDE.md` files in subdirectories of the project. Add this if you have a multi-package repo where each package ships its own CLAUDE.md — file an issue.

This is a *speed-bump* against prompt injection, not a guarantee. It catches:

- A malicious branch merging changes to CLAUDE.md.
- A dependency or scaffolding tool dropping a CLAUDE.md or `.claude/rules/*` into your project.
- An accidental edit you forgot you made — including one a Claude session made to your global `CLAUDE.md`.
- An `@import`ed file changing content even though CLAUDE.md itself didn't — each imported file is hashed independently.

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
