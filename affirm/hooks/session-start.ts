#!/usr/bin/env bun
import { relative } from "node:path";
import { classify, collectInstructionFiles, loadHashes, normalizeProjectDir } from "../lib/affirm";

export type BannerInput = {
  projectDir: string;
  files: string[];
  classification: ReturnType<typeof classify>;
};

export function buildBanner(input: BannerInput): string {
  const { projectDir, classification } = input;
  const { approved, added, changed } = classification;

  let msg = "Instruction files in this project:\n";
  for (const f of approved) msg += `  ✓ ${relative(projectDir, f)}\n`;
  for (const f of added) msg += `  ✦ ${relative(projectDir, f)}  [NEW — unaffirmed]\n`;
  for (const f of changed) msg += `  ✧ ${relative(projectDir, f)}  [CHANGED — unaffirmed]\n`;

  if (added.length > 0 || changed.length > 0) {
    msg += "\n⚠ Review unaffirmed files, then run /affirm.";
  }
  return msg.trimEnd();
}

if (import.meta.main) {
  try {
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
