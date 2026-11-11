/**
 * Placement of keys across processes and machines (D992). Three pieces, each stable across restarts and router
 * instances:
 *
 * - Buckets: 16 bits of an unkeyed hash of the placed key (for users, @eden/protocol's `bucketOf`). Everything below
 *   places buckets, never keys, so a table of 65,536 entries answers every lookup.
 * - `jumpHash`: Lamping and Veach's jump consistent hash. Going from n to n+1 slots moves 1/(n+1) of keys, all to the
 *   new slot; it is used for a machine's child processes, which only ever grow or shrink at the end.
 * - `OwnerTable`: rendezvous (highest random weight) hashing of the 65,536 buckets over named nodes. Adding a node moves
 *   about 1/(n+1) of buckets, all to it; removing any node (not only the last, as jump requires) moves only that
 *   node's buckets, each to its second choice. That is what failover needs: a dead machine's users spread over the
 *   others, and come back to it when it returns.
 *
 * Not on any hot path: a router builds a table once per membership change and reads one entry per request.
 */
import { fnv1a, mix32 } from "./hash";

/** Buckets a key space is cut into: 16 bits (the caller's bucket function, e.g. @eden/protocol's `bucketOf`). */
export const BUCKETS = 65_536;

/**
 * Jump consistent hash (Lamping and Veach, 2014) of a 32-bit key into [0, n). Exact to the paper's 64-bit generator
 * (BigInt): slow per call (a few microseconds), which is why callers build a table (`childTable`).
 */
export function jumpHash(key: number, n: number): number {
  if (!(n >= 1)) return 0;
  const mask = (1n << 64n) - 1n;
  let k = BigInt(key >>> 0);
  let b = -1;
  let j = 0;
  while (j < n) {
    b = j;
    k = (k * 2862933555777941757n + 1n) & mask;
    j = Math.floor(((b + 1) * 2 ** 31) / (Number(k >> 33n) + 1));
  }
  return b;
}

/**
 * The child process of each bucket on a machine with `n` children: jump over a second mix of the bucket, so the
 * children of one node do not inherit the node-level choice's pattern (rendezvous picks a node's buckets by score;
 * this spreads them evenly over its children). Uint8: at most 64 children (`MAX_PROCESSES`).
 */
export function childTable(n: number): Uint8Array {
  const t = new Uint8Array(BUCKETS);
  if (n <= 1) return t;
  for (let b = 0; b < BUCKETS; b++) t[b] = jumpHash(mix32(b ^ 0x5bd1e995), n);
  return t;
}

/** A node's weight for a bucket: rendezvous needs only a hash of (node, bucket) that is the same everywhere. */
function weight(nodeHash: number, bucket: number): number {
  return mix32(nodeHash ^ Math.imul(bucket + 1, 0x9e3779b1));
}

/**
 * Bucket → node index over `nodes` (stable ids, not addresses), by rendezvous hashing. Built in O(buckets x nodes):
 * about 1 ms per node. Nodes are named by id so that re-addressing a machine moves nobody; an id listed twice is one
 * node. With no node every bucket is -1.
 */
export class OwnerTable {
  readonly nodes: readonly string[];
  private readonly table: Int16Array;

  constructor(nodes: readonly string[]) {
    this.nodes = [...new Set(nodes)];
    if (this.nodes.length > 32_767) throw new Error("too many nodes");
    const hashes = this.nodes.map((id) => mix32(fnv1a(id, 0, id.length)));
    this.table = new Int16Array(BUCKETS).fill(-1);
    for (let b = 0; b < BUCKETS; b++) {
      let best = -1;
      let top = -1;
      for (let i = 0; i < hashes.length; i++) {
        const w = weight(hashes[i]!, b);
        // Ties (rare: 32-bit weights) go to the smaller id, so every builder agrees whatever the list's order.
        if (w > top || (w === top && this.nodes[i]! < this.nodes[best]!)) {
          top = w;
          best = i;
        }
      }
      this.table[b] = best;
    }
  }

  /** The owning node's index in `nodes`, or -1 when there are none. */
  ownerIndex(bucket: number): number {
    return this.table[bucket & (BUCKETS - 1)]!;
  }

  /** The owning node's id, or null when there are none. */
  owner(bucket: number): string | null {
    const i = this.ownerIndex(bucket);
    return i < 0 ? null : this.nodes[i]!;
  }

  /** Buckets whose owner differs between this table and `next` (as ids), in order. */
  moved(next: OwnerTable): number[] {
    const out: number[] = [];
    for (let b = 0; b < BUCKETS; b++) if (this.owner(b) !== next.owner(b)) out.push(b);
    return out;
  }
}
