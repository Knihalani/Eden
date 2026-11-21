import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A scratch directory for a test (D2087): `mkdtempSync(join(tmpdir(), `${prefix}-`))` that the run removes for the
 * caller. Benchmark and test files used to leave each run's dirs behind; on a long-lived box they accumulated to
 * ~15k entries and 12 GB. `bun test` never fires process "exit" handlers, so cleanup rides two hooks: the test
 * preload's global `afterAll` calls `tmpDirClean` (removing the file's dirs, crashed or timed-out tests included),
 * and the `exit` handler covers a plain `bun` run of a bench or script, which the preload does not load.
 */
export function tmpDir(prefix: string): string {
  if (!hooked) {
    hooked = true;
    process.once("exit", tmpDirClean);
  }
  const dir = mkdtempSync(join(tmpdir(), prefix.endsWith("-") ? prefix : `${prefix}-`));
  made.push(dir);
  return dir;
}

/** Remove every dir `tmpDir` made in this process. The test preload's `afterAll` calls it (see test-preload.ts). */
export function tmpDirClean(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

const made: string[] = [];
let hooked = false;
