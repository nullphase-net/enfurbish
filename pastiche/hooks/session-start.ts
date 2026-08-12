#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildContext, loadConfig, loadNotes, parseLedger, stalest } from "../lib/pastiche";

function debugLog(line: string) {
  if (!process.env.PASTICHE_DEBUG) return;
  try {
    appendFileSync(join(homedir(), ".claude", "pastiche-hook.log"),
      `${new Date().toISOString()}  ${line}\n`);
  } catch { /* best-effort */ }
}

export function buildOutput(pluginRoot: string): string | null {
  const cfg = loadConfig();
  if (!existsSync(cfg.ledger)) return null;
  const due = stalest(parseLedger(readFileSync(cfg.ledger, "utf8")), cfg.due);
  return buildContext({ cfg, due, notes: loadNotes(pluginRoot, cfg), pluginRoot });
}

if (import.meta.main) {
  // Never throw and never block: a SessionStart hook that fails should cost the
  // user nothing more than a session without vocabulary in it.
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dir, "..");
    const context = buildOutput(pluginRoot);
    if (context === null) {
      debugLog("no ledger — emitting empty");
      process.stdout.write("{}\n");
    } else {
      debugLog(`injected ${context.length} chars`);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
      }) + "\n");
    }
    process.exit(0);
  } catch (e) {
    debugLog(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.stdout.write("{}\n");
    process.exit(0);
  }
}
