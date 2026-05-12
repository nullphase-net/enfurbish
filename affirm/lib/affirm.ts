#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

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
};

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function collectInstructionFiles(projectDir: string): string[] {
  const root = normalizeProjectDir(projectDir);
  const out: string[] = [];
  const top = join(root, "CLAUDE.md");
  if (existsSync(top) && statSync(top).isFile()) out.push(top);

  const rulesDir = join(root, ".claude", "rules");
  if (existsSync(rulesDir) && statSync(rulesDir).isDirectory()) {
    walkRules(rulesDir, out);
  }
  return out.sort();
}

function walkRules(dir: string, out: string[]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkRules(full, out);
    else if (e.isFile()) out.push(full);
  }
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
  for (const f of files) {
    let cur: string;
    try {
      cur = sha256OfFile(f);
    } catch {
      continue;
    }
    const prev = stored[f];
    if (prev === undefined) added.push(f);
    else if (prev !== cur) changed.push(f);
    else approved.push(f);
  }
  return { approved, added, changed };
}

export function approveAll(projectDir: string, hashPath: string = HASH_FILE): { approved: Array<{ path: string; hash: string }> } {
  const files = collectInstructionFiles(projectDir);
  const stored = loadHashes(hashPath);
  const approved: Array<{ path: string; hash: string }> = [];
  for (const f of files) {
    const h = sha256OfFile(f);
    stored[f] = h;
    approved.push({ path: f, hash: h });
  }
  saveHashes(stored, hashPath);
  return { approved };
}

export function revokeProject(projectDir: string, hashPath: string = HASH_FILE): { revoked: string[] } {
  const files = collectInstructionFiles(projectDir);
  const stored = loadHashes(hashPath);
  const revoked: string[] = [];
  for (const f of files) {
    if (f in stored) {
      delete stored[f];
      revoked.push(f);
    }
  }
  saveHashes(stored, hashPath);
  return { revoked };
}
