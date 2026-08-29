/**
 * Novelty feed rank (Wave 12.3).
 *
 * Uncompiled frequent patterns sort by wasted tokens, then the named-miss
 * rank Home already used, then recency. Unique-work and empty input stay
 * empty — ranking never invents a row.
 */

export type WasteRankable = {
  wastedTokens?: number | null;
  status?: string;
  at?: number;
};

/** Replacement waiting / Read-set / Unbound loop sit above a plain pending row. */
export function namedMissRank(status: string): number {
  if (status === "Replacement waiting") return 0;
  if (status.startsWith("Read-set") || status === "Unbound loop") return 0;
  return 1;
}

function isUniqueWorkStatus(status: string | undefined): boolean {
  return typeof status === "string" && status.startsWith("Unique work");
}

function wasteOf(item: WasteRankable): number {
  const n = item.wastedTokens;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/**
 * Rank by wasted tokens desc, then named-miss, then recency.
 * Unique-work / empty → []. Does not invent rows.
 */
export function rankByWaste<T extends WasteRankable>(items: readonly T[] | null | undefined): T[] {
  if (!items || items.length === 0) return [];
  const live = items.filter((item) => !isUniqueWorkStatus(item.status));
  if (!live.length) return [];
  return [...live].sort((a, b) => {
    const dWaste = wasteOf(b) - wasteOf(a);
    if (dWaste) return dWaste;
    const dMiss = namedMissRank(a.status ?? "") - namedMissRank(b.status ?? "");
    if (dMiss) return dMiss;
    return (b.at ?? 0) - (a.at ?? 0);
  });
}
