import { STOP, codeToks, contentToks, groundRelativeTime, parseStamp, properNames, stem, textTimeToks } from "./text";

export type Cue = Map<string, number>;

const EXPAND: Record<string, string[]> = {
  [stem("spouse")]: ["married", "wife", "husband"].map(stem),
  [stem("wife")]: ["married", "spouse"].map(stem),
  [stem("husband")]: ["married", "spouse"].map(stem),
  [stem("citizen")]: ["nationality"].map(stem),
};

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
  for (const w of (String(hay ?? "").toLowerCase().match(/[a-z0-9]+(?:[.'\-][a-z0-9]+)*/g) ?? [])) toks.add(w);
  let n = 0;
  for (const t of terms) {
    if (toks.has(t) || toks.has(stem(t))) n++;
  }
  return n;
}

export class EpisodicStore {
  private post = new Map<string, [number, number][]>();
  private df = new Map<string, number>();
  private len: number[] = [];
  private avgLen = 1;

  ingest(turns: { text: string; speaker?: string; date?: string; session?: number }[]) {
    this.post.clear();
    this.df.clear();
    this.len = [];
    turns.forEach((t, i) => {
      const speaker = t.speaker || "speaker";
      const date = t.date || "";
      const stamp = parseStamp(date);
      const text = String(t.text || "").replace(/\s+/g, " ").trim();
      const grounded = groundRelativeTime(text, stamp);
      const key = new Map<string, number>();
      const bump = (f: string, w = 1) => key.set(f, (key.get(f) || 0) + w);
      const stems = contentToks(text);
      for (const s of stems) bump(s);
      for (let i = 0; i + 1 < stems.length; i++) bump(`${stems[i]}_${stems[i + 1]}`, 0.6);
      for (const n of properNames(text)) bump(`#${n}`, 1);
      for (const c of codeToks(text)) bump(`#${c}`, 1);
      if (speaker) bump(`@${speaker.toLowerCase()}`, 1);
      for (const t of (stamp ? [`t:y${stamp.y}`, `t:m${stamp.m}`, `t:${stamp.y}-${stamp.m}`, `t:d${stamp.d}`] : [])) bump(t, 1);
      for (const t of textTimeToks(text)) bump(t, 0.8);
      for (const g of grounded) for (const t of textTimeToks(g)) bump(t, 0.5);
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
    const out = new Float64Array(this.len.length);
    const N = this.len.length || 1;
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

  cueFor(q: string, timeW = 1.5): Cue {
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
    return cue;
  }
}
