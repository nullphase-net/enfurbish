import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";

const HEADER = `# Claude Code tooling journal

Append-only record of how the user's tooling stack performed across sessions.
Each \`##\` section is one \`/wrap\` invocation.
Verdicts: \`helped\` / \`hurt\` / \`neutral\`. Grep \`^- Action:\` for the improvement backlog.

---

`;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const journal = args.journal;
  if (!journal) {
    process.stderr.write("--journal required\n");
    process.exit(2);
  }
  const entry = await readStdin();
  if (entry.trim().length === 0) {
    // No-op; do not touch the file.
    process.exit(0);
  }

  const existing = existsSync(journal) ? readFileSync(journal, "utf8") : "";
  const base = existing.length === 0 || !existing.includes("# Claude Code tooling journal")
    ? HEADER + (existing.length ? existing + "\n" : "")
    : existing;
  // Ensure exactly one trailing newline before the new entry.
  const sep = base.endsWith("\n") ? "" : "\n";
  const next = base + sep + entry + (entry.endsWith("\n") ? "" : "\n");

  const tmp = journal + "." + process.pid + ".tmp";
  try {
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, journal);
    process.exit(0);
  } catch (e: any) {
    try { unlinkSync(tmp); } catch {}
    process.stderr.write(`journal-append failed: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}
