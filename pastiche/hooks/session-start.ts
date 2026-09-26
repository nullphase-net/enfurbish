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

/**
 * One line when this session runs a different version of this plugin than the checkout
 * it is working in. An edit there reaches no session until it ships ("Pushing is not
 * shipping", CLAUDE.md): three sessions ran a stale cached /wrap, one of them the
 * release of the plugin it was running, and pastiche's 0.5.x cache kept minting
 * duplicates after the 0.6.x guard was committed. Duplicated in each plugin's hook,
 * since plugins share no code. "" when the cwd is not this plugin's checkout (or the
 * plugin's own directory in it), the versions match, or a manifest will not read.
 */
export function supersededNote(pluginRoot: string, projectDir: string): string {
  const read = (dir: string) => {
    try {
      return JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const running = read(pluginRoot);
  if (typeof running?.name !== "string" || typeof running?.version !== "string") return "";
  const here = [join(projectDir, running.name), projectDir].map(read).find((m) => m?.name === running.name);
  if (typeof here?.version !== "string" || here.version === running.version) return "";
  const market = /\/plugins\/cache\/([^/]+)\//.exec(pluginRoot)?.[1];
  const update = market ? `\`claude plugin update ${running.name}@${market}\`` : "update the plugin";
  return `${running.name} ${running.version} is running, but this checkout has ${here.version}. ` +
    `It reaches sessions only through the marketplace: push, then ${update}, then /reload-plugins.`;
}

if (import.meta.main) {
  // Never throw and never block: a SessionStart hook that fails should cost the
  // user nothing more than a session without vocabulary in it.
  try {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || join(import.meta.dir, "..");
    const context = buildOutput(pluginRoot, readSessionId());
    const stale = supersededNote(pluginRoot, process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (context === null && !stale) {
      debugLog("no configured languages — emitting empty");
      process.stdout.write("{}\n");
    } else {
      debugLog(`injected ${context?.length ?? 0} chars${stale ? " + stale-copy note" : ""}`);
      // The vocabulary goes to the model only; a stale-copy note goes to both.
      process.stdout.write(JSON.stringify({
        ...(stale ? { systemMessage: stale } : {}),
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: [stale, context].filter(Boolean).join("\n\n"),
        },
      }) + "\n");
    }
    process.exit(0);
  } catch (e) {
    debugLog(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.stdout.write("{}\n");
    process.exit(0);
  }
}
