import { randomBytes } from "node:crypto";

/** A sortable, unique id: `<prefix>_<time base36><random hex>`. */
export function newId(prefix: string, now = Date.now()): string {
  return `${prefix}_${now.toString(36)}${randomBytes(6).toString("hex")}`;
}

/** The stable id of a source's item. */
export function itemId(sourceId: string, ref: string): string {
  return `${sourceId}:${ref}`;
}

/** One key per (tenant, user): everything learned or cached is partitioned by it. */
export function scopeKey(scope: { tenantId: string; userId: string }): string {
  return `${scope.tenantId}/${scope.userId}`;
}

/** Buckets a user is placed by (D992): 16 bits, far more than any machine or process count. */
export const BUCKETS = 65_536;

/**
 * The bucket of a tenant/user (D992): unkeyed, so every process and machine computes the same one. Every routing level
 * places by it (machines by `OwnerTable`, a machine's children by `childTable`, both in @eden/primitives), and it is
 * written in the clear in each persisted file's name, so a process can tell which files it owns, and move or delete
 * them, without decrypting them; it reveals 1/65,536 of a partition, no identity (p6-scale.md §6). FNV-1a over the
 * UTF-16 code units of "tenant NUL user", then murmur3's final mix.
 */
export function bucketOf(tenantId: string, userId: string): number {
  const key = `${tenantId}\0${userId}`;
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) & (BUCKETS - 1);
}
