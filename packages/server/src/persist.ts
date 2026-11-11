/**
 * The server's side of persisting frozen users (D425; on by default since D991). Since D992 every process of a
 * machine shares one directory: a file's name starts with its user's bucket, and each child reads, sweeps and cleans
 * up only the buckets it owns (`childTable`), so changing the child count moves nothing on disk: a user's new child
 * finds their file where it was. Kept out of `@eden/engine` so the router, which holds no user state, does not load
 * the engine.
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { childTable } from "@eden/primitives";

/**
 * Deletes the per-process directories of the layout before D992 (`<i>-of-<N>`): their files have names without a
 * bucket, which no process of this build reads. Those users re-sync once. Returns how many directories went.
 */
export function prunePersistDirs(base: string): number {
  let n = 0;
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^\d+-of-\d+$/.test(name)) continue;
    rmSync(join(base, name), { recursive: true, force: true });
    n++;
  }
  return n;
}

/** Whether child `index` of `count` owns a bucket (D992): the router routes by the same table. */
export function childOwns(index: number, count: number): (bucket: number) => boolean {
  const table = childTable(count);
  return (bucket) => table[bucket] === index;
}
