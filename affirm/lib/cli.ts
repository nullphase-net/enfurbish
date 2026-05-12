#!/usr/bin/env bun
import { relative } from "node:path";
import {
  HASH_FILE,
  approveAll,
  collectInstructionFiles,
  loadHashes,
  normalizeProjectDir,
  revokeProject,
  sha256OfFile,
} from "./affirm";

function usage(): string {
  return [
    "Usage:",
    "  affirm                affirm all CLAUDE.md / .claude/rules/* files in cwd",
    "  affirm --show         show affirmation status for files in cwd",
    "  affirm --revoke       remove affirmation for files in cwd",
    "  affirm --help         show this message",
  ].join("\n");
}

function statusOf(file: string, stored: Record<string, string>): string {
  const prev = stored[file];
  if (prev === undefined) return "NEW (not yet affirmed)";
  let cur: string;
  try {
    cur = sha256OfFile(file);
  } catch {
    return "unreadable";
  }
  if (prev !== cur) return "CHANGED (hash mismatch)";
  return "affirmed";
}

export type CliOpts = {
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
  hashPath?: string;
};

export function runCli(argv: string[], opts: CliOpts): number {
  const arg = argv[0];
  if (arg === "--help" || arg === "-h") {
    opts.out(usage());
    return 0;
  }

  const hashPath = opts.hashPath ?? HASH_FILE;
  const projectDir = normalizeProjectDir(opts.cwd);
  const files = collectInstructionFiles(projectDir);
  if (files.length === 0) {
    opts.out(`No CLAUDE.md or .claude/rules/ files found in ${projectDir}`);
    return 0;
  }

  if (arg === "--show") {
    const stored = loadHashes(hashPath);
    opts.out(`Instruction files in ${projectDir}:`);
    for (const f of files) {
      opts.out(`  ${relative(projectDir, f)}  [${statusOf(f, stored)}]`);
    }
    return 0;
  }

  if (arg === "--revoke") {
    const { revoked } = revokeProject(projectDir, hashPath);
    if (revoked.length === 0) {
      opts.out(`No prior affirmations to revoke in ${projectDir}.`);
    } else {
      opts.out(`Revoked ${revoked.length} affirmation${revoked.length === 1 ? "" : "s"} in ${projectDir}:`);
      for (const f of revoked) opts.out(`  ${relative(projectDir, f)}`);
      opts.out("");
      opts.out("Next session will surface these as unaffirmed.");
    }
    return 0;
  }

  if (arg !== undefined && arg !== "affirm") {
    opts.err(`Unknown argument: ${arg}\n\n${usage()}`);
    return 2;
  }

  const { approved } = approveAll(projectDir, hashPath);
  opts.out(`Affirmed ${approved.length} file${approved.length === 1 ? "" : "s"} in ${projectDir}:`);
  for (const { path, hash } of approved) {
    opts.out(`  ${relative(projectDir, path)}  (${hash.slice(0, 12)}…)`);
  }
  return 0;
}

if (import.meta.main) {
  const code = runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
  });
  process.exit(code);
}
