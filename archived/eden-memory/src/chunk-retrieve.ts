/**
 * M18.2 narrative retrieve: real BM25 over 512-token chunks (Report §4.2 EventQA 74.6).
 * GraphRAG EventQA 34.4 is the anti-pattern — no hops, OpenIE, PPR, RAPTOR, or ICL index.
 * Does not duplicate the chunker; M18.1 owns `chunkText` / `ChunkStore.put`.
 */
import { ChunkStore, chunkText, type NarrativeChunk } from "./chunk-store";
import * as arFusion from "./cls/controller";

/** Robertson / Lucene BM25. Not binary IDF. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const NARRATIVE_RETRIEVE_K = 10;

export type NarrativeChunkHit = {
  text: string;
  src?: string;
  t: number;
  id: string;
  score: number;
};

export type NarrativeFallback = {
  text?: string;
  id?: string;
  at?: number;
  lane?: string;
};

/** Local copy of index `tokList` regex. No FOLD (hours→tz would poison novels). Do not change `queryHay`. */
export function tokList(s: string): string[] {
  return (
    String(s ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? []
  );
}

function asTexts(v: unknown): string[] {
  if (!Array.isArray(v)) {
    if (typeof v === "string" && v.trim()) return [v.trim()];
    return [];
  }
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string") {
      const t = x.trim();
      if (t) out.push(t);
      continue;
    }
    if (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string") {
      const t = String((x as { text: string }).text).trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function docsFromChunks(rows: NarrativeChunk[]): { text: string; src?: string; t: number; id: string; i: number }[] {
  const out: { text: string; src?: string; t: number; id: string; i: number }[] = [];
  for (const row of rows) {
    const text = String(row?.text ?? "").trim();
    if (!text) continue;
    out.push({
      text,
      src: row.src,
      t: Number.isFinite(row.t) ? row.t : 0,
      id: row.id || `chunk:${row.src || "anon"}:${row.i}`,
      i: row.i,
    });
  }
  return out;
}

function loadStoredChunks(dir: string): { text: string; src?: string; t: number; id: string; i?: number }[] {
  try {
    return docsFromChunks(new ChunkStore(dir).all());
  } catch {
    return [];
  }
}

function lazyChunk(text: string): string[] {
  const t = String(text ?? "").trim();
  if (!t) return [];
  try {
    const parts = asTexts(chunkText(t));
    if (parts.length) return parts;
  } catch {}
  return [t];
}

function fallbackDocs(
  rows: NarrativeFallback[] | undefined,
): { text: string; src?: string; t: number; id: string; i: number }[] {
  if (!Array.isArray(rows) || !rows.length) return [];
  const out: { text: string; src?: string; t: number; id: string; i: number }[] = [];
  for (const row of rows) {
    if (!row || row.lane !== "narrative") continue;
    const text = String(row.text ?? "").trim();
    if (!text) continue;
    const parts = lazyChunk(text);
    for (let i = 0; i < parts.length; i++) {
      out.push({
        text: parts[i]!,
        src: row.id,
        t: typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0,
        id: `chunk:${row.id || "anon"}:${i}`,
        i,
      });
    }
  }
  return out;
}

/**
 * Okapi BM25: Robertson IDF `log((N-df+0.5)/(df+0.5)+1)` × TF with length norm
 * `k1≈1.2`, `b≈0.75`. Positive scores only, highest first.
 */
export function bm25Rank(query: string, docs: string[], k: number): { i: number; s: number }[] {
  const qToks = tokList(query);
  if (!qToks.length || !docs.length) return [];
  const take = Math.max(0, Math.floor(Number(k) || 0));
  if (!take) return [];
  const N = docs.length;
  const tfs: Map<string, number>[] = [];
  const dl: number[] = [];
  const df = new Map<string, number>();
  let sumDl = 0;
  for (const d of docs) {
    const m = new Map<string, number>();
    const toks = tokList(d);
    for (const w of toks) m.set(w, (m.get(w) || 0) + 1);
    for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
    tfs.push(m);
    const len = Math.max(1, toks.length);
    dl.push(len);
    sumDl += len;
  }
  const avgdl = sumDl / N;
  const k1 = BM25_K1;
  const b = BM25_B;
  const scored: { i: number; s: number }[] = [];
  for (let i = 0; i < docs.length; i++) {
    let s = 0;
    const tf = tfs[i]!;
    const len = dl[i]!;
    for (const w of qToks) {
      const n = tf.get(w) || 0;
      if (!n) continue;
      const d = df.get(w) || 0;
      const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
      s += (idf * (n * (k1 + 1))) / (n + k1 * (1 - b + b * (len / avgdl)));
    }
    if (s > 0) scored.push({ i, s });
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.slice(0, take);
}

/**
 * BM25 over persisted chunks, else in-memory `chunkText` of narrative records.
 * Empty cue → no dump. Never throws.
 */
export function retrieveNarrativeChunks(
  dir: string,
  cue: string,
  opts?: { k?: number; fallback?: NarrativeFallback[] },
): NarrativeChunkHit[] {
  try {
    const q = String(cue ?? "").trim();
    if (!q) return [];
    const k = Math.min(NARRATIVE_RETRIEVE_K, Math.max(0, Math.floor(Number(opts?.k) || NARRATIVE_RETRIEVE_K)));
    if (!k) return [];
    let docs = loadStoredChunks(dir);
    if (!docs.length) docs = fallbackDocs(opts?.fallback);
    if (!docs.length) return [];
    const poolK = Math.min(docs.length, Math.max(k, 40));
    const ranked = bm25Rank(
      q,
      docs.map((d) => d.text),
      poolK,
    );
    const hits: (NarrativeChunkHit & { i?: number })[] = [];
    for (const { i, s } of ranked) {
      const d = docs[i];
      if (!d) continue;
      hits.push({
        text: d.text,
        src: d.src,
        t: d.t,
        id: d.id,
        score: s,
        i: typeof d.i === "number" ? d.i : i,
      });
    }
    try {
      return arFusion.fuseArHits(q, hits, k);
    } catch {
      return hits.slice(0, k);
    }
  } catch {
    return [];
  }
}
