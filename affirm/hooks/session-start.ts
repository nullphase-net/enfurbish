#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { classify, collectInstructionFiles, loadHashes, normalizeProjectDir } from "../lib/affirm";
import { markFirstFire } from "../lib/first-fire";

export type BannerInput = {
  projectDir: string;
  files: string[];
  classification: ReturnType<typeof classify>;
};

export function buildBanner(input: BannerInput): string {
  const { projectDir, classification } = input;
  const { approved, added, changed } = classification;

  let msg = "Affirm: instruction files in this project:\n";
  for (const f of approved) msg += `  ✓ ${relative(projectDir, f)}\n`;
  for (const f of added) msg += `  ✦ ${relative(projectDir, f)}  [NEW — unaffirmed]\n`;
  for (const f of changed) msg += `  ✧ ${relative(projectDir, f)}  [CHANGED — unaffirmed]\n`;

  if (added.length > 0 || changed.length > 0) {
    msg += "\n⚠ Review unaffirmed files, then run /affirm.";
  }
  return msg.trimEnd();
}

/**
 * Read SessionStart hook payload from stdin and pull out `session_id`.
 * Best-effort: returns null on empty stdin, parse failure, or missing field.
 * Never throws — the hook must remain best-effort and never block the session.
 */
function readSessionIdFromStdin(): string | null {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    const obj = JSON.parse(raw);
    return typeof obj?.session_id === "string" ? obj.session_id : null;
  } catch {
    return null;
  }
}

const DEFAULT_FIRSTFIRE_DIR = join(homedir(), ".claude", "state", "affirm-firstfire");

if (import.meta.main) {
  try {
    // Re-fire suppression: if we've already fired for this session_id, exit silently.
    // Avoids the recurring "banner buried under N redundant SessionStart fires"
    // failure logged across many wraps in the tooling journal.
    const sessionId = readSessionIdFromStdin();
    if (sessionId) {
      const stateDir = process.env.AFFIRM_FIRSTFIRE_DIR || DEFAULT_FIRSTFIRE_DIR;
      if (!markFirstFire(stateDir, sessionId)) {
        process.stdout.write("{}\n");
        process.exit(0);
      }
    }

    const projectDir = normalizeProjectDir(process.env.CLAUDE_PROJECT_DIR || process.cwd());
    const files = collectInstructionFiles(projectDir);
    if (files.length === 0) {
      process.stdout.write("{}\n");
      process.exit(0);
    }
    const stored = loadHashes();
    const classification = classify(files, stored);
    const systemMessage = buildBanner({ projectDir, files, classification });
    process.stdout.write(JSON.stringify({ systemMessage }) + "\n");
    process.exit(0);
  } catch {
    process.stdout.write("{}\n");
    process.exit(0);
  }
}
