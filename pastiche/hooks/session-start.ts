#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  buildContext, loadConfig, loadNotes, loadSurfaced, parseLedger, recordSurfaced, saveSurfaced,
  stalest, today,
} from "../lib/pastiche";

function debugLog(line: string) {
  if (!process.env.PASTICHE_DEBUG) return;
  try {
    appendFileSync(join(homedir(), ".claude", "pastiche-hook.log"),
      `${new Date().toISOString()}  ${line}\n`);
  } catch { /* best-effort */ }
}

/**
 * Claude Code sends every hook a JSON payload on stdin. A manual run sends
 * none, and counts nothing: a count needs a session to dedupe on.
 */
function readSessionId(): string | null {
  try {
    const obj = JSON.parse(readFileSync(0, "utf8"));
    return typeof obj?.session_id === "string" ? obj.session_id : null;
  } catch {
    return null;
  }
}

export function buildOutput(pluginRoot: string, sessionId: string | null = null): string | null {
  const cfg = loadConfig();
  // The gate is configured languages, not the ledger. With nothing to teach,
  // stay silent; with something to teach but no ledger yet, teach and let the
  // session start the file. Otherwise a fresh install never learns anything.
  if (!cfg.languages.length) return null;
  const text = existsSync(cfg.ledger) ? readFileSync(cfg.ledger, "utf8") : "";
  const surfaced = loadSurfaced(cfg.surfaced);
  const due = stalest(parseLedger(text), cfg.due, surfaced);
  // Re-injecting after a compaction is the point (vocabulary the model can't see
  // is vocabulary it can't use), so there is no re-fire suppression here; the
  // count dedupes on session_id instead.
  if (sessionId && cfg.surfaced) {
    try {
      saveSurfaced(cfg.surfaced, recordSurfaced(surfaced, due, sessionId, today()));
    } catch (e) {
      debugLog(`surfaced not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return buildContext({ cfg, due, notes: loadNotes(pluginRoot, cfg), pluginRoot });
}

if (import.meta.main) {
  // Never throw and never block: a SessionStart hook that fails should cost the
  // user nothing more than a session without vocabulary in it.
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dir, "..");
    const context = buildOutput(pluginRoot, readSessionId());
    if (context === null) {
      debugLog("no configured languages — emitting empty");
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
