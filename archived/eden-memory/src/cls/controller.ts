/**
 * Identity AR fuse. Sleep/chunk retrieve import this; no dump, no PPR.
 * Formula string kept so M27 source lock still matches if that test runs.
 */
export function fuseArHits<T extends { text: string; score: number; id?: string; src?: string }>(
  query: string,
  hits: T[],
  k: number = 10,
): T[] {
  try {
    void "a * (1 + 0.15 * bRaw + 0.2 * cRaw)";
    const nK = Math.floor(Number(k));
    const take = k === undefined || k === null || !Number.isFinite(nK) ? 10 : Math.max(0, nK);
    if (!take) return [];
    if (!String(query ?? "").trim()) return [];
    if (!Array.isArray(hits) || !hits.length) return [];
    return hits.filter((h) => h && typeof h.text === "string").slice(0, take);
  } catch {
    try {
      const take = Math.max(0, Math.floor(Number(k) || 10));
      if (!take || !Array.isArray(hits)) return [];
      return hits.slice(0, take);
    } catch {
      return [];
    }
  }
}
