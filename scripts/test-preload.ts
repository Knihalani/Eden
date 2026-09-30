/**
 * Preloaded by bunfig.toml before any test module loads: no `bun test` run may touch the real
 * ~/.eden (issue #67). scripts/test.sh isolates HOME as well; this also covers `bun test <file>`.
 *
 * - Inherited EDEN_* variables are cleared, so none can point a test at a real store or key.
 *   Kept: the knobs that only steer test runs (EDEN_STRESS, and EDEN_FLAKE_CLOCK_* from
 *   scripts/flake-audit.sh, whose clock preload and tests read them).
 * - HOME becomes a fresh temp dir, removed after the run. Child processes inherit it.
 * - EDEN_HOME points inside it. Bun reads os.homedir() once at startup, so changing HOME here
 *   does not move in-process `EDEN_HOME || join(homedir(), ".eden")` fallbacks; EDEN_HOME does.
 *   A test that unsets EDEN_HOME still reaches the real ~/.eden: point it at a temp dir instead.
 *
 * Bun reads bunfig.toml from the working directory only: runs started in a subdirectory skip this.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEEP = /^EDEN_(STRESS|FLAKE_CLOCK_[A-Z_]+)$/;

for (const key of Object.keys(process.env)) {
  if (key.startsWith("EDEN_") && !KEEP.test(key)) delete process.env[key];
}

const home = mkdtempSync(join(tmpdir(), "eden-test-home-"));
process.env.HOME = home;
process.env.EDEN_HOME = join(home, ".eden");
// A global hook: process "exit" handlers do not run under `bun test`.
afterAll(() => rmSync(home, { recursive: true, force: true }));
