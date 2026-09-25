import { completeScores } from "./complete";
import { STOP, codeToks, contentToks, groundRelativeTime, parseStamp, properNames, stampToks, stem, textTimeToks, words, type Stamp } from "./text";

export type Episode = {
  i: number;
  speaker: string;
  text: string;
  date: string;
  session: number;

  render: string;

  key: Map<string, number>;
  grounded: string[];
  isQuestion: boolean;
};

export type Cue = Map<string, number>;

function stemExpand(raw: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, alts] of Object.entries(raw)) {
    const sk = stem(k);
    const merged = new Set([...(out[sk] ?? []), ...alts.map(stem)]);
    merged.delete(sk);
    out[sk] = [...merged];
  }
  return out;
}

const EXPAND = stemExpand({
  spouse: ["married", "wife", "husband"],
  wife: ["married", "spouse"],
  husband: ["married", "spouse"],
  citizen: ["nationality"],
});

const QUERY_LIGHT = new Set(
  ["country", "citizen", "author", "name", "city", "position", "sport", "nationality"].map(stem),
);

export function rareCueToks(q: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const t = String(raw ?? "").toLowerCase().trim();
    if (!t || t.length < 2 || STOP.has(t) || QUERY_LIGHT.has(stem(t)) || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const n of properNames(q)) add(n);
  for (const c of codeToks(q)) add(c);
  for (const t of contentToks(q)) {
    if (QUERY_LIGHT.has(t) || STOP.has(t)) continue;
    if (/\d/.test(t) || t.includes("-")) add(t);
  }
  for (const t of [...out]) {
    if (!t.includes("-")) continue;
    for (const p of t.split("-")) {
      if (p.length >= 4 || (/\d/.test(p) && /[a-z]/i.test(p))) add(p);
    }
  }
  return out;
}

export function rareTermHits(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const hay = String(text ?? "").toLowerCase();
  if (!hay) return 0;
  const toks = new Set(contentToks(hay));
  for (const w of words(hay)) toks.add(w);
  let n = 0;
  for (const t of terms) {
    if (toks.has(t) || toks.has(stem(t))) n++;
  }
  return n;
}

export function scoreChunksAsEpisodes(query: string, texts: string[]): Float64Array {
  const n = texts.length;
  const out = new Float64Array(n);
  if (!n || !String(query ?? "").trim()) return out;
  try {
    const epi = new EpisodicStore();
    epi.ingest(texts.map((text) => ({ text: String(text ?? ""), speaker: "nar", session: 0 })));
    const scored = epi.score(epi.cueFor(query));
    for (let i = 0; i < n; i++) out[i] = scored[i] || 0;
  } catch {}
  return out;
}

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

  score(cue: Cue): Float64Array {
    const out = new Float64Array(this.episodes.length);
    const N = this.episodes.length || 1;
    for (const [f, w] of cue) {
      const p = this.post.get(f);
      if (!p) continue;
      const d = this.df.get(f) || 0;
      const idf = Math.log((N - d + 0.5) / (d + 0.5) + 1);
      for (const [i, tf] of p) {
        out[i] += w * idf * ((tf * 2.2) / (tf + 1.2 * (0.5 + 0.5 * (this.len[i]! / this.avgLen))));
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
    for (const s of stems) bump(s, QUERY_LIGHT.has(s) ? 0.3 : 1);
    for (const s of stems) for (const alt of EXPAND[s] ?? []) bump(alt, 0.7);
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

  complete(cue: Cue, scores: Float64Array): Float64Array {
    try {
      const parts: string[] = [];
      for (const f of cue.keys()) {
        if (f.startsWith("#")) parts.push(f.slice(1));
        else if (!f.includes(":") && !f.includes("_") && !f.startsWith("@")) parts.push(f);
      }
      return completeScores(parts.join(" "), this.episodes, scores);
    } catch {
      return scores;
    }
  }
}
