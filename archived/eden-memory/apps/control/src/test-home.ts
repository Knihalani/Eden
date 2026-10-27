import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Points EDEN_HOME at a fresh temp dir for the calling test file and restores the previous value
 * after it. Call it at the top level of the file, before any test runs.
 *
 * Approve, promote, pause, resume and rollback run syncLiveTools(), which writes
 * `EDEN_HOME || ~/.eden` + `/live-tools.json`. Without this, a direct `bun test` overwrites the real
 * ~/.eden/live-tools.json (issue #67).
 */
export function useTempEdenHome(): string {
  const prev = process.env.EDEN_HOME;
  const home = mkdtempSync(join(tmpdir(), "eden-control-test-"));
  process.env.EDEN_HOME = home;
  afterAll(() => {
    if (prev === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}
