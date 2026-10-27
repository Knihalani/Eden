/**
 * Preloaded by bunfig.toml before any test module loads: no `bun test` run may touch the real ~/.eden.
 *
 * - Inherited EDEN_* and OPENROUTER_* variables are cleared, so no test can reach a real store or spend a real key.
 * - HOME becomes a fresh temp dir, removed after the run. Child processes inherit it.
 * - EDEN_HOME points inside it. Bun reads os.homedir() once at startup, so code that falls back to
 *   `join(homedir(), ".eden")` must read EDEN_HOME first (see packages/protocol/src/home.ts).
 *
 * Bun reads bunfig.toml from the working directory only: runs started in a subdirectory skip this.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("EDEN_") || key.startsWith("OPENROUTER_")) delete process.env[key];
}

const home = mkdtempSync(join(tmpdir(), "eden-test-home-"));
process.env.HOME = home;
process.env.EDEN_HOME = join(home, ".eden");
// A global hook: process "exit" handlers do not run under `bun test`.
afterAll(() => rmSync(home, { recursive: true, force: true }));
