/**
 * Gating source items off the event loop (D25). Redacting a lookup's items is the engine's largest synchronous cost
 * (docs/research/architecture-alternatives.md: at 96 lookups/s, inline gating put other users' request p99 at
 * 23.8 ms; a pool, 2–3 ms). `pooledSanitizer` runs `sanitizeItem` for each item through a `WorkerPool`, inline for
 * small items, where the message round trip costs more than the work.
 *
 * Fail closed: an item whose task fails (a batch past the pool's deadline, a crashed worker, an abort) is dropped,
 * never stored ungated. This module is also the pool's task module (`GATE_MODULE`): workers import it for `gateItem`.
 */
import type { WorkerPool } from "@eden/primitives";
import type { ContextItem } from "@eden/protocol";
import { DEFAULT_CACHE_LIMITS, sanitizeItem } from "./cache";

/** The module a gate pool's workers import (`PoolOptions.module`). */
export const GATE_MODULE = import.meta.url;

/** Pool task: one item made safe to hold (`sanitizeItem`). */
export function gateItem(input: { item: ContextItem; maxTextChars: number }): ContextItem {
  return sanitizeItem(input.item, input.maxTextChars);
}

/** A `SourceFanout` sanitize hook that gates items through `pool`, dropping any whose task fails. */
export function pooledSanitizer(
  pool: Pick<WorkerPool, "runOrInline">,
  maxTextChars = DEFAULT_CACHE_LIMITS.maxTextChars,
): (items: ContextItem[], signal?: AbortSignal) => Promise<ContextItem[]> {
  return async (items, signal) => {
    const gated = await Promise.allSettled(
      items.map((raw) => {
        // Clipped before the copy to the worker: sanitizeItem clips to the same lengths, so the result is unchanged.
        const item = { ...raw, title: raw.title.slice(0, 500), text: raw.text.slice(0, maxTextChars) };
        const cost = item.title.length + item.text.length;
        return pool.runOrInline<ContextItem>("gateItem", { item, maxTextChars }, cost, signal);
      }),
    );
    const out: ContextItem[] = [];
    for (const g of gated) if (g.status === "fulfilled") out.push(g.value);
    return out;
  };
}
