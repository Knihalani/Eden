/**
 * Island completions may carry scraped provider usage. The runtime unwraps
 * this without changing IslandCaller's return type for existing callers:
 * plain values still work; wrap/campaign opt in by returning IslandReply.
 *
 * Wave 2: scraped usage here is what retires extrapolated island tokens.
 */
export type IslandUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  cache_input_tokens?: number;
  /** Witness-memo hit: identical input already served. Class = memoized. */
  memoized?: boolean;
  /**
   * Waitable miss served via the provider Message Batches path.
   * Billed cents are half of sync; token counts stay the provider's full report.
   */
  batched?: true;
};

export class IslandReply {
  readonly value: unknown;
  readonly usage?: IslandUsage;
  constructor(value: unknown, usage?: IslandUsage) {
    this.value = value;
    this.usage = usage;
  }
}

export function unwrapIsland(out: unknown): { value: unknown; usage?: IslandUsage } {
  if (out instanceof IslandReply) return { value: out.value, usage: out.usage };
  return { value: out };
}

export function islandUsageTokens(u: IslandUsage | undefined): number {
  if (!u) return 0;
  const p = u.prompt_tokens;
  const c = u.completion_tokens;
  if (!Number.isFinite(p) || !Number.isFinite(c)) return 0;
  return p + c;
}
