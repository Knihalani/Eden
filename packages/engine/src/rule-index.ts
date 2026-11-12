/**
 * The semantic rule index (F10, docs/research/f10-rule-index.md): which of a user's active constraint cards are
 * nearest a request by meaning. It only selects: the push check still judges what it selected (D1270: no card is
 * handed and no check skipped on a score). F5's rule sheet (`pushCheckSheet`) renders the selection; the partner
 * wires the index (`PartnerDeps.ruleIndex`), builds the candidates (`sheetOf`) and races `select` against a short
 * wait, reading an unselected sheet when it is null, throws or is late (fail open).
 *
 * Implementations: the lab's replay of offline vectors (`packages/sim/src/lab/rule-index-replay.ts`) and the
 * server's on a small encoder (`@eden/encoder`'s `EncoderRuleIndex`). Neither calls a model or the network.
 */
import type { Scope } from "@eden/protocol";

/** One active constraint card as the index reads it: F5's sheet line plus the card's anticipated requests. */
export interface RuleCandidate {
  /** The item the card was made from (the user's cache id). */
  id: string;
  kind: string;
  /** Redacted text only (`sanitizeForStore`), as every field here. */
  statement: string;
  title: string;
  source: string;
  start?: string;
  end?: string;
  /** The card call's anticipated requests for the item (its "applies when" phrasings, intent lines). */
  requests?: readonly string[];
}

export interface RuleIndex {
  /**
   * The ids of at most `k` of `candidates`, nearest `request` first; null when the index cannot say (cold, not
   * loaded, too few cards embedded yet). Card and request text are data. State is kept per user (`scope`), never
   * shared across users.
   */
  select(
    scope: Scope,
    request: string,
    candidates: readonly RuleCandidate[],
    k: number,
    signal: AbortSignal,
    /** The days the request names (`timeWindow`, YYYY-MM-DD), for `ruleScore`'s span test; empty when none. */
    days?: readonly string[],
  ): Promise<readonly string[] | null>;
}

/**
 * The texts a card is matched by, one recipe for every index (the lab's vectors were made with it): its statement
 * and its title with its statement as e5 passages, and each anticipated request as an e5 query (request to request).
 * A card scores `ruleScore` over their cosines.
 */
export function ruleTexts(c: RuleCandidate): { passages: string[]; queries: string[] } {
  return {
    passages: [c.statement, `${c.title}. ${c.statement}`],
    queries: [...(c.requests ?? [])],
  };
}

/** How many of a card's best text matches its score averages (F10 §6: the best two beat the best one). */
export const RULE_TOP_TEXTS = 2;
/** Taken off a card whose span holds none of the days the request names (the engine's day grounding, no model). */
export const RULE_DAY_PENALTY = 0.03;

/**
 * A card's score from its texts' cosines to the request: the mean of its best `RULE_TOP_TEXTS`, less
 * `RULE_DAY_PENALTY` when the request names days and none falls in the card's span. NaN with no cosine.
 */
export function ruleScore(sims: readonly number[], card: RuleCandidate, days: readonly string[] = []): number {
  if (sims.length === 0) return Number.NaN;
  const best = [...sims].sort((a, b) => b - a).slice(0, RULE_TOP_TEXTS);
  let s = best.reduce((a, b) => a + b, 0) / best.length;
  if (days.length > 0 && (card.start || card.end)) {
    const inside = days.some((d) => (!card.start || d >= card.start) && (!card.end || d <= card.end));
    if (!inside) s -= RULE_DAY_PENALTY;
  }
  return s;
}

/** The best `k` ids by score, ties by id (no order of arrival); unscored candidates are left out. */
export function topRules(scores: ReadonlyMap<string, number>, k: number): string[] {
  return [...scores]
    .filter(([, s]) => Number.isFinite(s))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, Math.max(0, k))
    .map(([id]) => id);
}
