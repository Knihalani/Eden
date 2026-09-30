/**
 * M29.1 / M30.1 gist retrieve: hierarchical extractive maps on summary cues;
 * scored L0/L1 gists on book-length DetQA. No GraphRAG / OpenIE / PPR / RAPTOR
 * as a general agent. No LLM. No memory_search. Fail-open.
 * SessionStart stays pins + session gists — hier never dumps via latest().
 */
import { bm25Rank } from "./chunk-retrieve";
import { ChunkStore, type NarrativeChunk } from "./chunk-store";
import { GistStore, type Gist } from "./gist-store";

export const GIST_RETRIEVE_K = 3;
export const GIST_TOKEN_CAP = 300;
export const GIST_CHAR_CAP = 1200;

const SUMMARY_CUE = /\b(?:summarize|summary|summarise|tldr|recap|overview|synopsis|abstract)\b/i;
const SENT_SPLIT = /(?<=[.!?])\s+/;
const MEMORIZED_CUE = /Based on the context you memorized/i;
const QUESTION_MARK = /\bQuestion:/i;
const MC_CHOICES = /\bA\.\s[\s\S]*\bB\.\s[\s\S]*\bC\.\s[\s\S]*\bD\.\s/;
const DETECTIVE_QA = /\b(?:method of death|murder(?:er)?|killed|killer|detective|suspect|victim|alibi|culprit)\b/i;
const AS_QUESTION = /\?|\bQuestion:|\(\s*\)/;

export function isSummaryCue(cue: string): boolean {
  try {
    const s = String(cue ?? "");
    if (!s.trim()) return false;
    return SUMMARY_CUE.test(s);
  } catch {
    return false;
  }
}

/** DetQA / book-length MC. Summarize is NOT book-QA. Fail-open. Must not steal EventQA or SF. */
export function isBookQaCue(cue: string): boolean {
  try {
    const s = String(cue ?? "");
    if (!s.trim()) return false;
    if (isSummaryCue(s)) return false;
    if (MEMORIZED_CUE.test(s)) return true;
    // inject-agent retrieval_query strips "Question:" — official DetQA still has A./B./C./D.
    if (MC_CHOICES.test(s)) return true;
    if (QUESTION_MARK.test(s) && MC_CHOICES.test(s)) return true;
    if (AS_QUESTION.test(s) && DETECTIVE_QA.test(s)) return true;
    return false;
  } catch {
    return false;
  }
}

function firstSentence(chunk: string): string {
  for (const part of String(chunk ?? "").split(SENT_SPLIT)) {
    const s = part.trim();
    if (s) return s;
  }
  return "";
}

function lastSentence(chunk: string): string {
  const parts = String(chunk ?? "")
    .split(SENT_SPLIT)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  return parts[parts.length - 1]!;
}

function joinCap(parts: string[], cap = GIST_CHAR_CAP): string {
  let out = "";
  for (const raw of parts) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const next = out ? `${out} ${s}` : s;
    if (next.length > cap) {
      if (!out) return s.slice(0, cap);
      return out;
    }
    out = next;
    if (out.length >= cap) return out.slice(0, cap);
  }
  return out;
}

function capText(s: string): string {
  let t = String(s ?? "")
    .trim()
    .slice(0, GIST_CHAR_CAP);
  const toks = t.split(/\s+/).filter(Boolean);
  if (toks.length > GIST_TOKEN_CAP) t = toks.slice(0, GIST_TOKEN_CAP).join(" ");
  return t;
}

function evenPick<T>(arr: T[], k: number): T[] {
  if (k <= 0 || !arr.length) return [];
  if (arr.length <= k) return arr.slice();
  if (k === 1) return [arr[0]!];
  const out: T[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < k; i++) {
    const idx = Math.round((i * (arr.length - 1)) / (k - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(arr[idx]!);
  }
  return out;
}

/** Evenly spaced first-sentences (index 0, last, interpolated) until GIST_CHAR_CAP. */
function documentMap(chunks: NarrativeChunk[]): string {
  const sents: string[] = [];
  for (const c of chunks) {
    const s = firstSentence(c.text);
    if (s) sents.push(s);
  }
  if (!sents.length) return "";
  const n = sents.length;
  if (n === 1) return sents[0]!.slice(0, GIST_CHAR_CAP);
  let best = "";
  for (let count = 2; count <= n; count++) {
    const picked: string[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < count; i++) {
      const idx = Math.round((i * (n - 1)) / (count - 1));
      if (seen.has(idx)) continue;
      seen.add(idx);
      picked.push(sents[idx]!);
    }
    const joined = joinCap(picked);
    best = joined;
    if (joined.length >= GIST_CHAR_CAP) break;
  }
  return best;
}

function docT(chunks: NarrativeChunk[]): number {
  let t = 0;
  for (const c of chunks) {
    if (typeof c.t === "number" && Number.isFinite(c.t) && c.t > t) t = c.t;
  }
  return t || Date.now();
}

/**
 * InfBench packs each ~2k chars as its own src. Many tiny srcs are one document.
 * A real novel stored as one rec has hundreds of chunks on a single src.
 */
function documentGroups(chunks: NarrativeChunk[]): { src: string; chunks: NarrativeChunk[] }[] {
  const map = new Map<string, NarrativeChunk[]>();
  for (const c of chunks) {
    const k = typeof c.src === "string" ? c.src : "";
    let g = map.get(k);
    if (!g) {
      g = [];
      map.set(k, g);
    }
    g.push(c);
  }
  const groups = [...map.entries()].map(([src, ch]) => ({ src, chunks: ch }));
  if (groups.length <= 1) return groups;
  let maxLen = 0;
  for (const g of groups) if (g.chunks.length > maxLen) maxLen = g.chunks.length;
  if (maxLen <= 16) return [{ src: "", chunks }];
  return groups;
}

function buildHier(chunks: NarrativeChunk[], src: string, session: string): Gist[] {
  if (!chunks.length) return [];
  const t = docT(chunks);
  const srcOpt = src || undefined;
  const nodes: Gist[] = [];
  const l2 = documentMap(chunks);
  if (l2) {
    nodes.push({
      text: l2,
      session,
      t,
      kind: "hier",
      level: 2,
      i: 0,
      ...(srcOpt ? { src: srcOpt } : {}),
    });
  }
  for (let start = 0; start < chunks.length; start += 16) {
    const window = chunks.slice(start, start + 16);
    const sents: string[] = [];
    for (const c of window) {
      const s = firstSentence(c.text);
      if (s) sents.push(s);
    }
    const text = joinCap(sents);
    if (!text) continue;
    nodes.push({
      text,
      session,
      t: docT(window) || t,
      kind: "hier",
      level: 1,
      i: start,
      ...(srcOpt ? { src: srcOpt } : {}),
    });
  }
  if (chunks.length <= 32) {
    for (const c of chunks) {
      const first = firstSentence(c.text);
      const last = lastSentence(c.text);
      const parts = first && last && first !== last ? [first, last] : [first || last];
      const text = joinCap(parts);
      if (!text) continue;
      nodes.push({
        text,
        session,
        t: Number.isFinite(c.t) ? c.t : t,
        kind: "hier",
        level: 0,
        i: c.i,
        ...(srcOpt ? { src: srcOpt } : {}),
      });
    }
  }
  return nodes;
}

export type GistHit = { id: string; text: string; t: number; level: number; src?: string; i?: number };

function takeK(optsK: number | undefined): number {
  const want = optsK === undefined ? GIST_RETRIEVE_K : Math.floor(Number(optsK));
  return Math.min(GIST_RETRIEVE_K, Math.max(0, Number.isFinite(want) ? want : 0));
}

function toHits(picked: Gist[]): GistHit[] {
  return picked.map((g) => {
    const hit: GistHit = {
      id: `gist:${g.level ?? 0}:${g.t}:${g.i ?? 0}`,
      text: capText(g.text),
      t: g.t,
      level: typeof g.level === "number" ? g.level : 0,
    };
    if (g.src) hit.src = g.src;
    if (typeof g.i === "number" && Number.isFinite(g.i)) hit.i = g.i;
    return hit;
  });
}

function evenPickHier(rows: Gist[], k: number): Gist[] {
  const l2 = rows.filter((g) => g.level === 2);
  const l1 = rows.filter((g) => g.level === 1);
  const l0 = rows.filter((g) => g.level === 0);
  const picked: Gist[] = [];
  const seen = new Set<string>();
  const push = (g: Gist) => {
    if (picked.length >= k) return;
    const key = String(g.text ?? "").slice(0, 96);
    if (!key || seen.has(key)) return;
    seen.add(key);
    picked.push(g);
  };
  for (const g of l2) push(g);
  if (picked.length < k && l1.length) {
    for (const g of evenPick(l1, Math.min(3, k - picked.length))) push(g);
  }
  const few = rows.length <= 8 || l2.length + l1.length < k;
  if (picked.length < k && few && l0.length) {
    for (const g of evenPick(l0, k - picked.length)) push(g);
  }
  return picked;
}

function overlapCount(cue: string, text: string): number {
  const qToks = new Set(
    (
      String(cue)
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? []
    ).filter((w) => w.length > 2),
  );
  if (!qToks.size) return 0;
  let n = 0;
  for (const w of String(text ?? "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? []) {
    if (qToks.has(w)) n++;
  }
  return n;
}

/** Score hier gists vs cue. Prefer local L0/L1 when scores tie. */
function scoreHier(cue: string, rows: Gist[], k: number): Gist[] {
  const docs = rows.map((g) => String(g.text ?? ""));
  let ranked: { i: number; s: number }[] = [];
  try {
    ranked = bm25Rank(cue, docs, docs.length);
  } catch {
    ranked = [];
  }
  const bm = new Map<number, number>();
  for (const r of ranked) bm.set(r.i, r.s);
  const scored: { g: Gist; s: number; ov: number; level: number; i: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const g = rows[i]!;
    const s = bm.get(i) ?? 0;
    const ov = overlapCount(cue, g.text);
    if (s <= 0 && ov <= 0) continue;
    scored.push({
      g,
      s,
      ov,
      level: typeof g.level === "number" ? g.level : 99,
      i: typeof g.i === "number" && Number.isFinite(g.i) ? g.i : 0,
    });
  }
  scored.sort((a, b) => b.s - a.s || b.ov - a.ov || a.level - b.level || a.i - b.i);
  const picked: Gist[] = [];
  const seen = new Set<string>();
  for (const row of scored) {
    if (picked.length >= k) break;
    const key = String(row.g.text ?? "").slice(0, 96);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    picked.push(row.g);
  }
  return picked;
}

export function retrieveGists(dir: string, cue: string, opts?: { k?: number; session?: string }): GistHit[] {
  try {
    const q = String(cue ?? "").trim();
    if (!q) return [];
    const k = takeK(opts?.k);
    if (!k) return [];
    const root = String(dir ?? "");
    if (!root) return [];
    const summary = isSummaryCue(q);
    const bookQa = !summary && isBookQaCue(q);
    if (!summary && !bookQa) return [];
    const rows = new GistStore(root).hier();
    if (!rows.length) return [];
    const picked = summary ? evenPickHier(rows, k) : scoreHier(q, rows, k);
    return toHits(picked);
  } catch {
    return [];
  }
}

function gistWindows(hits: GistHit[]): { src: string; i: number; level: number }[] {
  const out: { src: string; i: number; level: number }[] = [];
  for (const h of hits || []) {
    out.push({
      src: String(h?.src ?? "").trim(),
      i: typeof h?.i === "number" && Number.isFinite(h.i) ? h.i : 0,
      level: typeof h?.level === "number" && Number.isFinite(h.level) ? h.level : 0,
    });
  }
  return out;
}

function chunkSupportsGist(c: NarrativeChunk, w: { src: string; i: number; level: number }): boolean {
  if (w.src && c.src && c.src !== w.src) return false;
  if (w.level >= 2) return !w.src || c.src === w.src;
  if (w.level === 1) return (c.i ?? 0) >= w.i && (c.i ?? 0) < w.i + 16;
  return Math.abs((c.i ?? 0) - w.i) <= 1;
}

/**
 * Book-QA leftover: BM25 chunks that support retrieved gists (same src or near gist.i).
 * Empty gist src (InfBench grouped tiny srcs) → existing BM25 leftover. Fail-open.
 */
export function leftoverChunksForGists<T extends { id?: string; text?: string }>(
  lexical: T[],
  hits: GistHit[],
  dir: string,
  room: number,
): T[] {
  try {
    const cap = Math.max(0, Math.floor(Number(room) || 0));
    const rows = Array.isArray(lexical) ? lexical : [];
    if (!cap) return [];
    if (!rows.length) return [];
    const windows = gistWindows(hits);
    const srcs = windows.map((w) => w.src).filter(Boolean);
    if (!srcs.length) return rows.slice(0, cap);
    let order = rows;
    try {
      const gistQ = (hits || [])
        .map((h) => String(h?.text ?? ""))
        .filter(Boolean)
        .join(" ");
      if (gistQ) {
        const ranked = bm25Rank(
          gistQ,
          rows.map((r) => String(r.text ?? "")),
          rows.length,
        );
        if (ranked.length) {
          const seen = new Set<number>();
          const next: T[] = [];
          for (const { i } of ranked) {
            if (seen.has(i)) continue;
            seen.add(i);
            const row = rows[i];
            if (row) next.push(row);
          }
          for (let i = 0; i < rows.length; i++) if (!seen.has(i)) next.push(rows[i]!);
          order = next;
        }
      }
    } catch {}
    const storeRows = new ChunkStore(dir).ingestOrder();
    const byId = new Map(storeRows.map((c) => [c.id, c]));
    const byText = new Map(storeRows.map((c) => [c.text, c]));
    const scored: { row: T; d: number }[] = [];
    for (const row of order) {
      const c = (row.id && byId.get(row.id)) || (row.text && byText.get(String(row.text)));
      if (!c) continue;
      let best = Infinity;
      for (const w of windows) {
        if (!chunkSupportsGist(c, w)) continue;
        best = Math.min(best, Math.abs((c.i ?? 0) - w.i));
      }
      if (best < Infinity) scored.push({ row, d: best });
    }
    if (!scored.length) return rows.slice(0, cap);
    scored.sort((a, b) => a.d - b.d);
    return scored.slice(0, cap).map((s) => s.row);
  } catch {
    const cap = Math.max(0, Math.floor(Number(room) || 0));
    return Array.isArray(lexical) ? lexical.slice(0, cap) : [];
  }
}

export function promoteNarrativeGists(dir: string, session?: string): void {
  try {
    const root = String(dir ?? "");
    if (!root) return;
    // Ingest order, not UUID src sort — InfBench packs are many small srcs of one book.
    const chunks = new ChunkStore(root).ingestOrder();
    const sess = typeof session === "string" ? session : "";
    const nodes: Gist[] = [];
    for (const doc of documentGroups(chunks)) {
      nodes.push(...buildHier(doc.chunks, doc.src, sess));
    }
    new GistStore(root).replaceHier(nodes);
  } catch {
    // Fail-open: never throw into inject/sleep. Do not touch session LWW gists.
  }
}
