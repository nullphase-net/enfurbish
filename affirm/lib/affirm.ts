#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { buildInstructionGraph } from "./imports";

export const HASH_FILE = join(homedir(), ".claude", "affirm-hashes.json");

export function normalizeProjectDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export type Classification = {
  approved: string[];
  added: string[];
  changed: string[];
  /** Could not be hashed. Reported, never dropped: a missing line reads as all-clear. */
  unreadable: string[];
};

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Roots (CLAUDE.md + .claude/rules/**) plus any files they @import, transitively.
// The full graph (depth/provenance/out-of-tree/global) lives in ./imports; classify and
// approve only need the flat path list.
export function collectInstructionFiles(projectDir: string): string[] {
  return buildInstructionGraph(projectDir)
    .files.map((f) => f.path)
    .sort();
}

export function loadHashes(path: string = HASH_FILE): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return typeof data === "object" && data !== null ? data : {};
  } catch {
    return {};
  }
}

export function saveHashes(hashes: Record<string, string>, path: string = HASH_FILE): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(hashes, null, 2) + "\n");
  renameSync(tmp, path);
}

export function classify(files: string[], stored: Record<string, string>): Classification {
  const approved: string[] = [];
  const added: string[] = [];
  const changed: string[] = [];
  const unreadable: string[] = [];
  for (const f of files) {
    let cur: string;
    try {
      cur = sha256OfFile(f);
    } catch {
      unreadable.push(f);
      continue;
    }
    const prev = stored[f];
    if (prev === undefined) added.push(f);
    else if (prev !== cur) changed.push(f);
    else approved.push(f);
  }
  return { approved, added, changed, unreadable };
}

/**
 * Per file, like `classify`: one unreadable file used to throw before the store was
 * written, so every readable file beside it went unaffirmed too (symbion b6e).
 */
export function approveAll(
  projectDir: string,
  hashPath: string = HASH_FILE,
): { approved: Array<{ path: string; hash: string }>; unreadable: string[] } {
  const files = collectInstructionFiles(projectDir);
  const stored = loadHashes(hashPath);
  const approved: Array<{ path: string; hash: string }> = [];
  const unreadable: string[] = [];
  for (const f of files) {
    let h: string;
    try {
      h = sha256OfFile(f);
    } catch {
      unreadable.push(f);
      continue;
    }
    stored[f] = h;
    approved.push({ path: f, hash: h });
  }
  saveHashes(stored, hashPath);
  return { approved, unreadable };
}
