/**
 * Gating source items off the event loop (D25). Redacting a lookup's items is the engine's largest synchronous cost
 * (docs/research/architecture-alternatives.md: at 96 lookups/s, inline gating put other users' request p99 at
 * 23.8 ms; a pool, 2–3 ms). `pooledSanitizer` runs `sanitizeItem` for each item through a `WorkerPool`, inline for
 * small items, where the message round trip costs more than the work.
 *
 * Fail closed: when any item's task fails (a batch past the pool's deadline, a crashed worker, an abort), the whole
 * result is rejected: nothing ungated is stored, and `SourceFanout` treats the call as failed (no fresh cache entry,
 * a breaker failure, a stale result served if it has one) rather than caching a result with items silently missing.
 * This module is also the pool's task module (`GATE_MODULE`): workers import it for `gateItem`.
 */
import type { WorkerPool } from "@eden/primitives";
import type { ContextItem } from "@eden/protocol";
import { DEFAULT_CACHE_LIMITS, sanitizeItem } from "./cache";
import { head } from "./text";

/** The module a gate pool's workers import (`PoolOptions.module`). */
export const GATE_MODULE = import.meta.url;

/** Pool task: one item made safe to hold (`sanitizeItem`). */
export function gateItem(input: { item: ContextItem; maxTextChars: number }): ContextItem {
  return sanitizeItem(input.item, input.maxTextChars);
}

/** A `SourceFanout` sanitize hook that gates items through `pool`; rejects if any item's task fails. */
export function pooledSanitizer(
  pool: Pick<WorkerPool, "runOrInline">,
  maxTextChars = DEFAULT_CACHE_LIMITS.maxTextChars,
): (items: ContextItem[], signal?: AbortSignal) => Promise<ContextItem[]> {
  return async (items, signal) => {
    const gated = await Promise.allSettled(
      items.map((raw) => {
        // Clipped before the copy to the worker: sanitizeItem clips to the same lengths, so the result is unchanged.
        const item = { ...raw, title: head(raw.title, 500), text: head(raw.text, maxTextChars) };
        const cost = item.title.length + item.text.length;
        return pool.runOrInline<ContextItem>("gateItem", { item, maxTextChars }, cost, signal);
      }),
    );
    const failed = gated.filter((g) => g.status === "rejected").length;
    if (failed > 0) throw new Error(`gate failed for ${failed} of ${items.length} items`);
    return gated.map((g) => (g as PromiseFulfilledResult<ContextItem>).value);
  };
}
