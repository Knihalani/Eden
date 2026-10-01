// Lexical machinery: tokenizer, BM25F (subject/text/aliases), char-trigram similarity, context augmentation.
export const STOP = new Set(
  (
    "a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he her here hers herself him himself his how i if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she should shouldn't so some such than that that's the their theirs them themselves then there there's these they this those through to too under until up very was wasn't we were weren't what what's when where which while who whom why with won't would wouldn't you your yours yourself yourselves " +
    "ok okay yes yeah yep sure thanks thank please just also get got getting need needs want wants like use used using uses make makes way thing things something anything one two again still really now know tell show let lets go going do done does doing did can could should would will may might im ive youre whats hows wheres whos isnt dont doesnt cant here there than then us we our ours my me i you it its hey hi hello"
  ).split(/\s+/),
);

export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ss|us|is)$/.test(w)) return w;
  if (w.endsWith("es") && /(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** Content tokens: compound identifiers kept whole (next.config.ts, @acme/cli, err_require_esm) AND split into parts. */
export function toks(s: string): string[] {
  const t = s.toLowerCase().replace(/[’']/g, "");
  const out: string[] = [];
  for (const m of t.match(/[a-z0-9@~][a-z0-9_.\-/@:~*]*[a-z0-9*]|[a-z0-9]/g) ?? []) {
    const parts = m.split(/[^a-z0-9]+/).filter(Boolean);
    if (parts.length > 1) out.push(m.replace(/[.:\-/]+$/, ""));
    for (const p of parts) if (p.length >= 2 && !STOP.has(p) && !/^\d{1,2}$/.test(p)) out.push(stem(p));
  }
  return out;
}

export type Doc = { id: string; scope: string; kind: string; subject: string; text: string; aliases?: string[] };
type Field = { name: string; w: number; get: (d: Doc) => string };

export class BM25F {
  fields: Field[];
  k1 = 1.2;
  b = 0.75;
  N: number;
  df = new Map<string, number>();
  avg: number[];
  dtf: Map<string, number>[][];
  dlen: number[][];
  byId = new Map<string, number>();
  constructor(
    public docs: Doc[],
    withAliases: boolean,
  ) {
    this.fields = [
      { name: "subject", w: 2, get: (d) => d.subject },
      { name: "text", w: 1, get: (d) => d.text },
    ];
    if (withAliases) this.fields.push({ name: "aliases", w: 1.5, get: (d) => (d.aliases ?? []).join(" ; ") });
    this.N = docs.length;
    this.avg = this.fields.map(() => 0);
    this.dtf = [];
    this.dlen = [];
    docs.forEach((d, i) => {
      this.byId.set(d.id, i);
      const seen = new Set<string>();
      const tfs: Map<string, number>[] = [],
        lens: number[] = [];
      this.fields.forEach((f, fi) => {
        const ts = toks(f.get(d));
        const m = new Map<string, number>();
        for (const t of ts) {
          m.set(t, (m.get(t) ?? 0) + 1);
          seen.add(t);
        }
        tfs.push(m);
        lens.push(ts.length);
        this.avg[fi] += ts.length;
      });
      this.dtf.push(tfs);
      this.dlen.push(lens);
      for (const t of seen) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    });
    this.avg = this.avg.map((a) => Math.max(1, a / Math.max(1, this.N)));
  }
  idf(t: string) {
    const df = this.df.get(t) ?? 0;
    return df ? Math.log(1 + (this.N - df + 0.5) / (df + 0.5)) : 0;
  }
  /** returns score and gating features for doc i */
  score(q: string[], i: number): { s: number; maxIdf: number; nMatch: number; dfs: number[] } {
    let s = 0,
      maxIdf = 0,
      nMatch = 0;
    const dfs: number[] = [];
    const uq = [...new Set(q)];
    for (const t of uq) {
      let tf = 0;
      this.fields.forEach((f, fi) => {
        const c = this.dtf[i]![fi]!.get(t);
        if (c) tf += (f.w * c) / (1 - this.b + (this.b * this.dlen[i]![fi]!) / this.avg[fi]!);
      });
      if (tf > 0) {
        const idf = this.idf(t);
        s += (idf * tf) / (this.k1 + tf);
        nMatch++;
        dfs.push(this.df.get(t) ?? 0);
        if (idf > maxIdf) maxIdf = idf;
      }
    }
    return { s, maxIdf, nMatch, dfs };
  }
}

export function trigrams(ws: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of ws) {
    if (w.length < 3) continue;
    const x = `#${w}#`;
    for (let i = 0; i + 3 <= x.length; i++) {
      const g = x.slice(i, i + 3);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
  }
  return m;
}
export function triCos(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (const [g, c] of a) {
    na += c * c;
    const d = b.get(g);
    if (d) dot += c * d;
  }
  for (const c of b.values()) nb += c * c;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const GENERIC_SEG = new Set([
  "apps",
  "packages",
  "services",
  "infra",
  "src",
  "lib",
  "app",
  "components",
  "index",
  "page",
  "ts",
  "tsx",
  "js",
  "json",
  "yaml",
  "tf",
  "test",
  "spec",
  "e2e",
  "routes",
  "jobs",
  "commands",
  "ui",
  "plugins",
  "helm",
  "terraform",
  "db",
]);
/** M7: append previous-turn text and path tokens (basename + meaningful dir segments) to the cue. */
export function ctxCue(cue: string, lastPaths: string[], prev: string): string {
  const segs: string[] = [];
  for (const p of lastPaths)
    for (const s of p.split(/[\\/]/)) {
      const base = s.replace(/\.[a-z0-9]+$/i, "").replace(/[()]/g, "");
      for (const w of base.split(/[-_.]/))
        if (w && !GENERIC_SEG.has(w.toLowerCase()) && !segs.includes(w.toLowerCase())) segs.push(w.toLowerCase());
    }
  return [cue, prev, segs.join(" ")].filter(Boolean).join(" \n ");
}
export function visible(scope: string, d: Doc) {
  return d.scope === "" || d.scope === scope;
}
