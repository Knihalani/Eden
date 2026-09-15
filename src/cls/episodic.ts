/**
 * Episodic store (hippocampus): pattern-separated, time-indexed episodes with sparse
 * high-dimensional keys — unigram stems, hashed bigrams, entity tags, time buckets — and
 * attractor-style pattern completion (retrieve → re-cue from top hits → retrieve, with decay).
 */
import { codeToks, contentToks, groundRelativeTime, parseStamp, properNames, stampToks, textTimeToks, type Stamp } from "./text";

export type Episode = {
  i: number;
  speaker: string;
  text: string;
  date: string;
  session: number;
  /** Rendered form returned to callers. */
  render: string;
  /** Sparse key: feature -> tf */
  key: Map<string, number>;
  grounded: string[];
  isQuestion: boolean;
};

export type Cue = Map<string, number>;

export function featurize(text: string, speaker: string, stamp: Stamp, grounded: string[]): Map<string, number> {
  const key = new Map<string, number>();
  const bump = (f: string, w = 1) => key.set(f, (key.get(f) || 0) + w);
  const stems = contentToks(text);
  for (const s of stems) bump(s);
  for (let i = 0; i + 1 < stems.length; i++) bump(`${stems[i]}_${stems[i + 1]}`, 0.6);
  for (const n of properNames(text)) bump(`#${n}`, 1);
  for (const c of codeToks(text)) bump(`#${c}`, 1);
  if (speaker) bump(`@${speaker.toLowerCase()}`, 1);
  for (const t of stampToks(stamp)) bump(t, 1);
  for (const t of textTimeToks(text)) bump(t, 0.8);
  for (const g of grounded) for (const t of textTimeToks(g)) bump(t, 0.5);
  return key;
}

export type Hit = { i: number; s: number };

export class EpisodicStore {
  episodes: Episode[] = [];
  /** feature -> [episode idx, tf][] */
  private post = new Map<string, [number, number][]>();
  private df = new Map<string, number>();
  private len: number[] = [];
  private avgLen = 1;

  ingest(turns: { text: string; speaker?: string; date?: string; session?: number }[]) {
    this.episodes = [];
    this.post.clear();
    this.df.clear();
    this.len = [];
    turns.forEach((t, i) => {
      const speaker = t.speaker || "speaker";
      const date = t.date || "";
      const stamp = parseStamp(date);
      const text = String(t.text || "").replace(/\s+/g, " ").trim();
      const grounded = groundRelativeTime(text, stamp);
      const key = featurize(text, speaker, stamp, grounded);
      const render = `${speaker}:${date ? ` [${date}]` : ""} ${text}${grounded.length ? ` {≈ ${grounded.join("; ")}}` : ""}`;
      const ep: Episode = { i, speaker, text, date, session: t.session ?? 0, render, key, grounded, isQuestion: /\?/.test(text) };
      this.episodes.push(ep);
      let l = 0;
      for (const [f, tf] of key) {
        l += tf;
        const p = this.post.get(f);
        if (p) p.push([i, tf]);
        else this.post.set(f, [[i, tf]]);
        this.df.set(f, (this.df.get(f) || 0) + 1);
      }
      this.len.push(Math.max(1, l));
    });
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.len.length);
  }

  /** BM25-style sparse dot product between a cue and every episode. */
  score(cue: Cue, k1 = 1.2, b = 0.5): Float64Array {
    const out = new Float64Array(this.episodes.length);
    const N = this.episodes.length || 1;
    for (const [f, w] of cue) {
      if (!w) continue;
      const p = this.post.get(f);
      if (!p) continue;
      const d = this.df.get(f) || 0;
      const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
      for (const [i, tf] of p) {
        out[i] += w * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (this.len[i]! / this.avgLen))));
      }
    }
    return out;
  }

  tagFrames(facts: { ep: number; frames: Iterable<string> }[]) {
    for (const f of facts) for (const fr of f.frames) {
      const feat = `f:${fr}`, ep = this.episodes[f.ep];
      if (!ep || ep.key.has(feat)) continue;
      ep.key.set(feat, 1);
      const p = this.post.get(feat); if (p) p.push([f.ep, 1]); else this.post.set(feat, [[f.ep, 1]]);
      this.df.set(feat, (this.df.get(feat) || 0) + 1); this.len[f.ep]! += 1;
    }
    this.avgLen = this.len.reduce((a, b) => a + b, 0) / Math.max(1, this.len.length);
  }

  cueFor(q: string, timeW = 1.5, frame?: string | null): Cue {
    const cue: Cue = new Map();
    const bump = (f: string, w: number) => cue.set(f, (cue.get(f) || 0) + w);
    const stems = contentToks(q);
    for (const s of stems) bump(s, 1);
    for (let i = 0; i + 1 < stems.length; i++) bump(`${stems[i]}_${stems[i + 1]}`, 0.5);
    for (const n of properNames(q)) {
      bump(`#${n}`, 1.5);
      bump(`@${n}`, 0.6);
    }
    for (const c of codeToks(q)) bump(`#${c}`, 2);
    for (const t of textTimeToks(q)) bump(t, timeW);
    if (frame) bump(`f:${frame}`, 2);
    return cue;
  }

  topK(scores: Float64Array, k: number, min = 1e-9): Hit[] {
    const idx: number[] = [];
    for (let i = 0; i < scores.length; i++) if (scores[i]! > min) idx.push(i);
    idx.sort((a, b) => scores[b]! - scores[a]!);
    return idx.slice(0, k).map((i) => ({ i, s: scores[i]! }));
  }

  /**
   * Pattern completion: iterative attractor retrieval. Round r re-cues with the rare
   * features of the top-m hits (decayed), so partial cues converge to the episode that
   * bridges to the answer (multi-hop) while common features are ignored.
   */
  complete(cue: Cue, scores: Float64Array): Float64Array {
    const maxDf = Math.max(4, Math.round(this.episodes.length * 0.02));
    let cur: Cue = new Map(cue);
    let acc = scores;
    let s = scores;
    for (let r = 1; r < 3; r++) {
      const top = this.topK(s, 3);
      if (!top.length) break;
      const best = top[0]!.s || 1;
      const next: Cue = new Map(cur);
      let added = 0;
      for (const h of top) {
        const rel = h.s / best;
        if (rel < 0.4) continue;
        for (const [f, tf] of this.episodes[h.i]!.key) {
          if (cue.has(f) || f.startsWith("t:") || f.startsWith("@")) continue;
          if ((this.df.get(f) || 0) > maxDf || f.includes("_")) continue;
          next.set(f, (next.get(f) || 0) + 0.35 * rel * Math.min(1, tf));
          added++;
        }
      }
      if (!added) break;
      cur = next;
      s = this.score(cur);
      const w = Math.pow(0.35, r);
      const merged = new Float64Array(acc.length);
      for (let i = 0; i < acc.length; i++) merged[i] = acc[i]! + w * s[i]!;
      acc = merged;
    }
    return acc;
  }

  /** Same-session neighbours (for dialogue chunk reconstruction). */
  neighbours(i: number): { prev?: Episode; next?: Episode } {
    const e = this.episodes[i]!;
    const prev = i > 0 && this.episodes[i - 1]!.session === e.session ? this.episodes[i - 1] : undefined;
    const next = i + 1 < this.episodes.length && this.episodes[i + 1]!.session === e.session ? this.episodes[i + 1] : undefined;
    return { prev, next };
  }
}
