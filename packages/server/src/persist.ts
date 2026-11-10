/**
 * The server's side of persisting frozen users (D425, opt-in): each process's own directory, and the directories of
 * another process count, deleted before any child starts. Kept out of `@eden/engine` so the router, which holds no
 * user state, does not load the engine.
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * A process's own directory under the operator's (D425): `<i>-of-<n>`, one per router child, as each keeps its own
 * source-map file (D163). Users are pinned to one child, so a child reads only blobs it wrote.
 */
export function childPersistDir(base: string, index: number, count: number): string {
  return join(base, `${index}-of-${count}`);
}

/**
 * Deletes the directories of any other process count (D425): after N changes, users move to other children, whose
 * own directories do not hold them. Their blobs are deleted, not moved (a name does not say which child owns its
 * user); those users re-sync, as their memory state would (D163). Returns how many directories went.
 */
export function prunePersistDirs(base: string, count: number): number {
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = /^(\d+)-of-(\d+)$/.exec(name);
    if (!m) continue;
    if (Number(m[2]) === count && Number(m[1]) < count) continue;
    rmSync(join(base, name), { recursive: true, force: true });
    n++;
  }
  return n;
}
