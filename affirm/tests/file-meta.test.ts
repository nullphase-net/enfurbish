import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMtime } from "../lib/file-meta";

test("getMtime returns the file's mtime in milliseconds", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-meta-"));
  const f = join(dir, "x.txt");
  writeFileSync(f, "hi");
  // Set mtime to a known epoch second
  utimesSync(f, 1715000000, 1715000000);
  expect(getMtime(f)).toBe(1715000000 * 1000);
});

test("getMtime returns null for missing files", () => {
  expect(getMtime("/no/such/file/anywhere")).toBeNull();
});
