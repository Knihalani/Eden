import { EpisodicStore, rareCueToks, rareTermHits } from "./episodic";
import { contentToks } from "./text";

export function fuseArHits<T extends { text: string; score: number; id?: string; src?: string }>(
  query: string,
  hits: T[],
  k: number = 10,
): T[] {
  try {
    const nK = Math.floor(Number(k));
    const take = k === undefined || k === null || !Number.isFinite(nK) ? 10 : Math.max(0, nK);
    if (!take) return [];
    const q = String(query ?? "").trim();
    if (!q) return [];
    if (!Array.isArray(hits) || !hits.length) return [];
    const raw = hits.filter((h) => h && typeof h.text === "string");
    if (!raw.length) return [];

    const rare = rareCueToks(q);
    const cueTerms = [...new Set([...rare, ...contentToks(q)])];
    const pool = cueTerms.length ? raw.filter((h) => rareTermHits(h.text, cueTerms) >= 1) : raw;
    if (!pool.length) return [];

    const texts = pool.map((h) => h.text);
    const epiRaw = new Float64Array(texts.length);
    try {
      const epi = new EpisodicStore();
      epi.ingest(texts.map((text) => ({ text: String(text ?? ""), speaker: "nar", session: 0 })));
      const scored = epi.score(epi.cueFor(q));
      for (let i = 0; i < texts.length; i++) epiRaw[i] = scored[i] || 0;
    } catch {}
    const rareHits = pool.map((h) => rareTermHits(h.text, rare));
    const fused = new Float64Array(pool.length);
    for (let i = 0; i < pool.length; i++) {
      const a = Number(pool[i]!.score) || 0;
      const hitsN = rareHits[i]!;
      const comb = a * Math.max(1, hitsN);
      const bRaw = epiRaw[i] || 0;
      fused[i] = comb * (1 + 0.15 * bRaw);
    }

    const idx = pool.map((h, i) => { const extra = h as typeof h & { i?: unknown }; if (typeof extra.i === "number" && Number.isInteger(extra.i) && extra.i >= 0) return extra.i; const m = String(h.id ?? "").match(/:(\d+)$/); return m ? Number(m[1]) : i; });
    const spread = Float64Array.from(fused);
    for (let i = 0; i < pool.length; i++) {
      if (rareHits[i]! < 1) continue;
      for (let j = 0; j < pool.length; j++) {
        if (i === j) continue;
        const ia = idx[i]!, ib = idx[j]!;
        if (Math.abs(ia - ib) !== 1) continue;
        const aHit = pool[i]!, bHit = pool[j]!;
        const sa = typeof aHit.src === "string" ? aHit.src : "";
        const sb = typeof bHit.src === "string" ? bHit.src : "";
        const w = sa && sb && sa === sb ? 1.25 : rareHits[j]! > 0 ? 0.45 : 0;
        if (w <= 0) continue;
        spread[j] += w * fused[i]!;
      }
    }

    const order = pool.map((_, i) => i);
    order.sort((ia, ib) => spread[ib]! - spread[ia]! || ia - ib);
    return order.slice(0, take).map((i) => pool[i]!);
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
