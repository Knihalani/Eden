/**
 * Preloaded by bunfig.toml before any test module loads: no `bun test` run may touch the real ~/.eden.
 *
 * - Inherited EDEN_* and OPENROUTER_* variables are cleared, so no test can reach a real store or spend a real key.
 * - HOME becomes a fresh temp dir, removed after the run. Child processes inherit it.
 * - EDEN_HOME points inside it. Bun reads os.homedir() once at startup, so code that falls back to
 *   `join(homedir(), ".eden")` must read EDEN_HOME first (see packages/protocol/src/home.ts).
 * - TZ is UTC, so a date reads the same on every host.
 * - One ref'd interval stays alive for the run, so Bun does not spin a core while a test waits on unref'd timers.
 *
 * Bun reads bunfig.toml from the working directory only: runs started in a subdirectory skip this.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpDirClean } from "../packages/primitives/src/tmpdir";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("EDEN_") || key.startsWith("OPENROUTER_")) delete process.env[key];
}

// One zone for every run, whatever the host's: a test that reads a date must not pass on one machine and fail on
// another. Bun applies TZ when it is set, so this holds for the test files loaded after the preload. Child processes
// inherit it; tz.test.ts runs its own under other zones.
process.env.TZ = "UTC";

const home = mkdtempSync(join(tmpdir(), "eden-test-home-"));
process.env.HOME = home;
process.env.EDEN_HOME = join(home, ".eden");
// Bun 1.4.4 busy-polls when the only pending timers are unref'd ones (an `unref()`'d setTimeout, AbortSignal.timeout):
// a 1.5 s wait burns about 1.5 s of CPU instead of ~4 ms. The engine and sources unref their deadline timers so they
// never hold a process open, and tests wait on them for real (ask-deadline.test.ts spent 7.7 s of CPU idling). One
// ref'd timer anywhere stops the spin; it never fires in a run (one hour), and the afterAll below clears it, so it
// cannot keep a finished run open. Remove it once Bun no longer spins (re-run the repro in docs/TESTING.md).
const keepAlive = setInterval(() => {}, 3_600_000);

// A global hook: process "exit" handlers do not run under `bun test`, so scratch cleanup is per file here.
afterAll(() => {
  clearInterval(keepAlive);
  tmpDirClean();
  rmSync(home, { recursive: true, force: true });
});
