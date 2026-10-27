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
