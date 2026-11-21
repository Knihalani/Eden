import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A scratch directory for a test (D2087): `mkdtempSync(join(tmpdir(), `${prefix}-`))` that the process removes at
 * exit. Benchmark and test files used to leave each run's dirs behind; on a long-lived box they accumulated to
 * ~15k entries and 12 GB. Exit cleanup — not `afterAll` — so a crashed or timed-out test cleans up too, and a
 * non-test caller needs nothing from `bun:test`.
 */
export function tmpDir(prefix: string): string {
  if (!hooked) {
    hooked = true;
    process.once("exit", () => {
      for (const d of made) rmSync(d, { recursive: true, force: true });
    });
  }
  const dir = mkdtempSync(join(tmpdir(), prefix.endsWith("-") ? prefix : `${prefix}-`));
  made.push(dir);
  return dir;
}

const made: string[] = [];
let hooked = false;
