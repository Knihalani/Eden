import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Eden's data directory: `$EDEN_HOME`, else `~/.eden`. Created `0700` on first use. */
export function edenHome(): string {
  const dir = process.env.EDEN_HOME || join(homedir(), ".eden");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
