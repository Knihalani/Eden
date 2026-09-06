/**
 * Token-class ledger — ROADMAP §13 / Wave 2.
 *
 * Five billed classes sum to provider prompt+completion. Provider cache is
 * recorded beside them and MUST NOT enter DC% (see @eden/measure dcShare).
 */
export const TOKEN_CLASSES = ["compiled", "memoized", "transparent", "steered-skip", "frontier"] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];

export type TokenClasses = {
  compiled: number;
  memoized: number;
  transparent: number;
  steeredSkip: number;
  frontier: number;
  /** Provider cache hits — never added into DC% numerator or denominator. */
  providerCache?: number;
};

export function emptyTokenClasses(): TokenClasses {
  return { compiled: 0, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 0 };
}

export function tokenClassKey(c: TokenClass): Exclude<keyof TokenClasses, "providerCache"> {
  return c === "steered-skip" ? "steeredSkip" : c;
}

export function addTokenClass(into: TokenClasses, cls: TokenClass, n: number): void {
  if (!(n > 0)) return;
  into[tokenClassKey(cls)] += n;
}

/** Billed total: the five classes. Cache is excluded. */
export function billedTokens(c: TokenClasses): number {
  return c.compiled + c.memoized + c.transparent + c.steeredSkip + c.frontier;
}

/**
 * Total input tokens for cache-hit % — stamped denom, or explicit write.
 * Never billed/DC%. Do not infer dialect from cached ≤ prompt.
 *
 * OpenAI (write unknown): denom = prompt_tokens (cached is a subset).
 * Anthropic (write stamped, including 0): cache_read + cache_creation + input_tokens.
 * `cacheDenom` from parse time always wins.
 */
export function providerCacheHitInput(
  cached: number | null | undefined,
  prompt: number | null | undefined,
  cacheWrite?: number | null,
  cacheDenom?: number | null,
): number | null {
  if (cacheDenom != null && Number.isFinite(cacheDenom) && cacheDenom >= 0) return cacheDenom;
  if (cached == null || prompt == null) return null;
  if (!Number.isFinite(cached) || !Number.isFinite(prompt)) return null;
  const c = cached > 0 ? cached : 0;
  const p = prompt > 0 ? prompt : 0;
  if (cacheWrite != null && Number.isFinite(cacheWrite)) {
    const w = cacheWrite > 0 ? cacheWrite : 0;
    return c + p + w;
  }
  if (!(p > 0) && !(c > 0)) return 0;
  return p;
}

/**
 * Provider cache-hit rate against that dialect's total input.
 * 0 when measured zero; null when unmeasured. Capped at 1. Never billed/DC%.
 */
export function providerCacheHitPct(
  cached: number | null | undefined,
  prompt: number | null | undefined,
  cacheWrite?: number | null,
  cacheDenom?: number | null,
): number | null {
  const input = providerCacheHitInput(cached, prompt, cacheWrite, cacheDenom);
  if (input == null) return null;
  if (!(input > 0)) return 0;
  const c = cached != null && Number.isFinite(cached) && cached > 0 ? cached : 0;
  const ratio = c / input;
  return ratio > 1 ? 1 : ratio;
}

/**
 * Ledger vs a recorded provider window (prompt+completion). Cache must not
 * be required for equality — it is a separate line.
 */
export function reconcileTokenClasses(
  c: TokenClasses,
  provider: { prompt: number; completion: number },
): { ok: boolean; billed: number; provider: number; delta: number } {
  const billed = billedTokens(c);
  const total = (provider.prompt ?? 0) + (provider.completion ?? 0);
  return { ok: billed === total, billed, provider: total, delta: billed - total };
}
