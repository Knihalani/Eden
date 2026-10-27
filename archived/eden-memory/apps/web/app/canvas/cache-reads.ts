/**
 * Honest cache copy for Home and canvas. Lookups === 0 (or absent) is silence —
 * never a fake 0% or "uncached" on a run that never consulted the cache.
 */

export function cacheReadsLine(hits?: number | null, lookups?: number | null): string | null {
  if (lookups == null || !Number.isFinite(lookups) || lookups <= 0) return null;
  const h = Math.max(0, Math.round(Number.isFinite(hits as number) ? Number(hits) : 0));
  const m = Math.round(lookups);
  return `${h} of ${m} reads from cache`;
}

/** Home list: words only. Digits stay off the status line (skip-count pin). */
export function cacheRunWord(hits?: number | null, lookups?: number | null): string | null {
  if (lookups == null || !Number.isFinite(lookups) || lookups <= 0) return null;
  const h = Number.isFinite(hits as number) ? Math.max(0, Number(hits)) : 0;
  return h > 0 ? "cached this run" : "uncached this run";
}
