import type { AgentMemory } from "../index";
import { completeScores } from "./complete";
import { EpisodicStore, rareCueToks, rareTermHits, scoreChunksAsEpisodes, type Cue, type Episode } from "./episodic";
import { SemanticStore } from "./semantic";
import { properNames, stem, contentToks } from "./text";

function bodyKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 24);
}

export class CLSController {
  readonly epi = new EpisodicStore();
  readonly sem = new SemanticStore();
  private bodyIndex = new Map<string, number[]>();
  private canonCache = new Map<string, number>();

  constructor(private cortex: AgentMemory, private opts: { skipCortex?: boolean; skipSemantic?: boolean } = {}) {}

  ingest(turns: { text: string; speaker?: string; date?: string; session?: number }[]) {
    this.epi.ingest(turns);
    if (!this.opts.skipSemantic) {
      this.sem.compile(this.epi.episodes);
      this.epi.tagFrames(this.sem.facts);
    }
    this.bodyIndex.clear();
    this.canonCache.clear();
    for (const e of this.epi.episodes) {
      const k = bodyKey(e.text);
      if (!k) continue;
      const l = this.bodyIndex.get(k);
      if (l) l.push(e.i);
      else this.bodyIndex.set(k, [e.i]);
    }
    if (this.opts.skipCortex) return;
    this.cortex.quiet(() => {
      this.cortex.observe(this.epi.episodes.map((e) => ({
        role: "user",
        content: e.date ? `${e.speaker}: [${e.date}] ${e.text}` : `${e.speaker}: ${e.text}`,
      })));
    });
  }

  private canon(note: string): number {
    const hit = this.canonCache.get(note);
    if (hit !== undefined) return hit;
    const body = note
      .replace(/^[A-Za-z][A-Za-z0-9 /._-]{0,32}:\s*/, "")
      .replace(/^\[[^\]]*\]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    let out = -1;
    const cands = this.bodyIndex.get(bodyKey(body));
    if (cands) {
      for (const i of cands) {
        const full = this.epi.episodes[i]!.text;
        if (full === body || full.startsWith(body) || full.includes(body)) {
          out = i;
          break;
        }
      }
    }
    if (out < 0) {
      const top = this.epi.topK(this.epi.score(this.epi.cueFor(body)), 1);
      if (top.length) out = top[0]!.i;
    }
    this.canonCache.set(note, out);
    return out;
  }

  private norm(v: Float64Array | Map<number, number>, n: number): Float64Array {
    const out = new Float64Array(n);
    let max = 0;
    if (v instanceof Map) {
      for (const [i, s] of v) if (s > max) max = s;
      if (max > 0) for (const [i, s] of v) out[i] = s / max;
    } else {
      for (let i = 0; i < n; i++) if (v[i]! > max) max = v[i]!;
      if (max > 0) for (let i = 0; i < n; i++) out[i] = v[i]! / max;
    }
    return out;
  }

  private bindQA(s: Float64Array): Float64Array {
    const eps = this.epi.episodes;
    const out = new Float64Array(s.length);
    for (let i = 0; i < s.length; i++) {
      let v = s[i]!;
      const prev = i > 0 && eps[i - 1]!.session === eps[i]!.session ? eps[i - 1]! : undefined;
      const next = i + 1 < s.length && eps[i + 1]!.session === eps[i]!.session ? eps[i + 1]! : undefined;
      if (prev && prev.isQuestion) v += 0.45 * s[i - 1]!;
      if (next && eps[i]!.isQuestion) v += 0.27 * s[i + 1]!;
      out[i] = v;
    }
    return out;
  }

  private fuseLane(a: number, bRaw: number, cRaw: number): number {
    return a * (1 + 0.15 * bRaw + 0.2 * cRaw);
  }

  private lexicalHits(cue: Cue, q: string, n: number): { hit: boolean[]; active: boolean } {
    const names = new Set<string>();
    for (const x of properNames(q)) names.add(stem(x));
    const hit = Array<boolean>(n).fill(false);
    let active = false;
    for (const [f] of cue) {
      if (f.startsWith("#") || f.startsWith("@") || names.has(f)) continue;
      for (let i = 0; i < n; i++) {
        if (!this.epi.episodes[i]!.key.has(f)) continue;
        hit[i] = true;
        active = true;
      }
    }
    return { hit, active };
  }

  scores(q: string, opts?: { complete?: boolean; semantic?: boolean; recency?: boolean }): Float64Array {
    const n = this.epi.episodes.length;
    const temporal = /\b(when|what time|what day|what date|which day|what year|what month|how long ago|date|year|month|ago|yesterday|last week|before|after|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(q.toLowerCase()) || /\b20\d{2}\b/.test(q);
    const cue: Cue = this.epi.cueFor(q, temporal ? 2 : 1.5, SemanticStore.frameOf(q));
    const base = this.epi.score(cue);
    const epi = this.norm(this.bindQA(base), n);
    const semRaw = new Float64Array(n);
    if (opts?.semantic !== false && !this.opts.skipSemantic) {
      for (const [i, s] of this.sem.lookup(q)) if (i >= 0 && i < n) semRaw[i] = s;
    }
    const cortexMap = new Map<number, number>();
    const notes = this.opts.skipCortex ? [] : this.cortex.notesFor(q, 20, { fuse: false });
    notes.forEach((m, r) => {
      const i = this.canon(m.text);
      if (i >= 0) cortexMap.set(i, Math.max(cortexMap.get(i) || 0, 1 / (1 + 0.35 * r)));
    });
    const { hit: lexHit, active: lexActive } = this.lexicalHits(cue, q, n);
    const fused = new Float64Array(n);
    const recencyDen = Math.max(1, n - 1);
    for (let i = 0; i < n; i++) {
      const a = epi[i]!, bRaw = semRaw[i]!, cRaw = cortexMap.get(i) || 0;
      if (!a && !bRaw && !cRaw) continue;
      if (lexActive && !lexHit[i]) continue;
      let v = this.fuseLane(a, bRaw, cRaw);
      if (temporal) {
        const e = this.epi.episodes[i]!;
        if (e.grounded.length || /\b20\d{2}\b/.test(e.text)) v *= 1.25;
      }
      fused[i] = v * (opts?.recency === false ? 1 : 1 + 0.06 * (i / recencyDen));
    }
    if (opts?.semantic !== false && !this.opts.skipSemantic) {
      for (const f of this.sem.facts) {
        if (f.supersededBy === undefined) continue;
        const old = f.ep, nu = f.supersededBy;
        if (fused[old]! <= 0) continue;
        fused[nu] = Math.max(fused[nu]!, fused[old]! * 1.05 + 1e-6);
        fused[old] = 0;
      }
    }
    if (opts?.complete === false) return fused;
    return completeScores(q, this.epi.episodes, fused);
  }

  chunk(e: Episode): string {
    const eps = this.epi.episodes, i = e.i;
    const prev = i > 0 && eps[i - 1]!.session === e.session ? eps[i - 1]!.render : "";
    const next = i + 1 < eps.length && eps[i + 1]!.session === e.session ? eps[i + 1]!.render : "";
    return [prev, e.render, next].filter(Boolean).join("\n");
  }

  retrieve(q: string, k: number, opts?: { neighbors?: boolean; complete?: boolean; semantic?: boolean; recency?: boolean }): string[] {
    if (!this.epi.episodes.length) return this.cortex.notesFor(q, k, { fuse: false }).map((m) => m.text);
    const fused = this.scores(q, opts);
    const top = this.epi.topK(fused, k);
    const expand = opts?.neighbors !== false;
    return top.map((h) => {
      const e = this.epi.episodes[h.i]!;
      return expand ? this.chunk(e) : e.render;
    });
  }
}

const AR_SPREAD_SEQ = 1.25;

const AR_SPREAD_SHARED = 0.45;

function arHitIndex<T extends { id?: string }>(hit: T, fallback: number): number {
  const extra = hit as T & { i?: unknown };
  if (typeof extra.i === "number" && Number.isInteger(extra.i) && extra.i >= 0) return extra.i;
  const id = String(hit.id ?? "");
  const m = id.match(/:(\d+)$/);
  if (m) return Number(m[1]);
  return fallback;
}

function arAdjacentWeight<T extends { text: string; src?: string; id?: string }>(
  a: T,
  b: T,
  ia: number,
  ib: number,
  rare: string[],
  cueTerms: string[],
): number {
  if (Math.abs(ia - ib) !== 1) return 0;
  if (cueTerms.length && rareTermHits(b.text, cueTerms) < 1) return 0;
  const sa = typeof a.src === "string" ? a.src : "";
  const sb = typeof b.src === "string" ? b.src : "";
  if (sa && sb && sa === sb) return AR_SPREAD_SEQ;
  if (rare.length && rareTermHits(a.text, rare) > 0 && rareTermHits(b.text, rare) > 0) return AR_SPREAD_SHARED;
  return 0;
}

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
    const epiRaw = scoreChunksAsEpisodes(q, texts);
    const rareHits = pool.map((h) => rareTermHits(h.text, rare));
    const fused = new Float64Array(pool.length);
    for (let i = 0; i < pool.length; i++) {
      const a = Number(pool[i]!.score) || 0;
      const hitsN = rareHits[i]!;
      const comb = a * Math.max(1, hitsN);
      const bRaw = epiRaw[i] || 0;
      fused[i] = comb * (1 + 0.15 * bRaw);
    }

    const idx = pool.map((h, i) => arHitIndex(h, i));
    const spread = Float64Array.from(fused);
    for (let i = 0; i < pool.length; i++) {
      if (rareHits[i]! < 1) continue;
      for (let j = 0; j < pool.length; j++) {
        if (i === j) continue;
        const w = arAdjacentWeight(pool[i]!, pool[j]!, idx[i]!, idx[j]!, rare, cueTerms);
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
