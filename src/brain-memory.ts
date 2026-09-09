/**
 * Hippocampal–Cortical Memory (HCM) — product synthesis of brain-inspired POCs.
 *
 * Lanes:
 *   episodic  — every dated turn (hippocampus)
 *   semantic  — Eden durable extract (neocortex)
 *   schema    — per-speaker profiles (cortical gist)
 *   graph     — co-occurrence spreading activation
 *   salience  — rarity / name / digit prior
 *
 * Retrieve = RRF fuse of BM25(episodic) + ASA + temporal + schema + salience + Eden notesFor.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type AgentMemory } from "./index";

export type BrainTurn = {
  text: string;
  speaker?: string;
  date?: string;
  session?: number;
  at?: number;
};

const STOP = new Set(
  "the of is a an on to and in for this that with from into about these then still has out how what why was are you your its our not or no hey hi hello yeah yes ok okay thanks thank".split(" "),
);

function toks(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? []).filter((w) => w.length >= 2 && !STOP.has(w));
}

function properNames(s: string): string[] {
  return s.match(/\b[A-Z][a-z]{2,14}\b/g) ?? [];
}

function dateTokens(date: string): string[] {
  return toks(date.replace(/,/g, " "));
}

function formatTurn(t: BrainTurn): string {
  const sp = t.speaker || "speaker";
  const date = t.date ? ` [${t.date}]` : "";
  return `${sp}:${date} ${t.text}`.replace(/\s+/g, " ").trim();
}

/** Strip `Speaker: [date] ` prefix from a note, collapse whitespace. */
function noteBody(note: string): string {
  return note
    .replace(/^[A-Za-z][A-Za-z0-9 /._-]{0,32}:\s*/, "")
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function bodyKey(body: string): string {
  return body.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 24);
}

function bm25(query: string, docs: string[], k: number): string[] {
  const N = docs.length || 1;
  const dl = docs.map((d) => Math.max(1, toks(d).length));
  const avgdl = dl.reduce((a, b) => a + b, 0) / N;
  const df = new Map<string, number>();
  const tfs = docs.map((d) => {
    const m = new Map<string, number>();
    for (const w of toks(d)) m.set(w, (m.get(w) || 0) + 1);
    for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
    return m;
  });
  const q = toks(query);
  const k1 = 1.5, b = 0.75;
  return docs
    .map((d, i) => {
      let s = 0;
      const tf = tfs[i]!;
      for (const w of q) {
        const n = tf.get(w) || 0;
        if (!n) continue;
        const idf = Math.log((N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5) + 1);
        s += idf * ((n * (k1 + 1)) / (n + k1 * (1 - b + b * (dl[i]! / avgdl))));
      }
      return { d, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.d);
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

type Bm25Index = { tfs: Map<string, number>[]; df: Map<string, number>; dl: number[]; avgdl: number; N: number };

function bm25Index(tokLists: string[][]): Bm25Index {
  const N = tokLists.length || 1;
  const dl = tokLists.map((t) => Math.max(1, t.length));
  const avgdl = dl.reduce((a, b) => a + b, 0) / N;
  const df = new Map<string, number>();
  const tfs = tokLists.map((ts) => {
    const m = new Map<string, number>();
    for (const w of ts) m.set(w, (m.get(w) || 0) + 1);
    for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
    return m;
  });
  return { tfs, df, dl, avgdl, N };
}

function bm25Scores(query: string, ix: Bm25Index): number[] {
  const q = toks(query);
  const k1 = 1.5, b = 0.75;
  const out = new Array<number>(ix.tfs.length).fill(0);
  for (const w of q) {
    const d = ix.df.get(w) || 0;
    if (!d) continue;
    const idf = Math.log((ix.N - d + 0.5) / (d + 0.5) + 1);
    for (let i = 0; i < ix.tfs.length; i++) {
      const n = ix.tfs[i]!.get(w) || 0;
      if (!n) continue;
      out[i] += idf * ((n * (k1 + 1)) / (n + k1 * (1 - b + b * (ix.dl[i]! / ix.avgdl))));
    }
  }
  return out;
}

function topK(docs: string[], scores: number[], k: number): string[] {
  const idx: number[] = [];
  for (let i = 0; i < scores.length; i++) if (scores[i]! > 0) idx.push(i);
  idx.sort((a, b) => scores[b]! - scores[a]!);
  return idx.slice(0, k).map((i) => docs[i]!);
}

function rrfFuse(lists: string[][], k: number, rrfK = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((d, i) => score.set(d, (score.get(d) || 0) + 1 / (rrfK + i + 1)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([d]) => d);
}

export class BrainMemory {
  private episodic: string[] = [];
  private turns: BrainTurn[] = [];
  private graph = new Map<string, Map<string, number>>();
  private noteToks: string[][] = [];
  private ctx: number[][] = [];
  private profiles = new Map<string, string[]>();
  private sal: number[] = [];
  private bodyIndex = new Map<string, number[]>();
  private canonCache = new Map<string, string>();
  private epiIx: Bm25Index | null = null;
  private noteSets: Set<string>[] = [];
  private epiPos = new Map<string, number>();
  private semantic: AgentMemory;
  private dir: string;

  constructor(opts: { dir?: string } = {}) {
    this.dir = opts.dir || mkdtempSync(join(tmpdir(), "eden-brain-"));
    this.semantic = openMemory({ dir: this.dir });
  }

  ingestTurns(turns: BrainTurn[]) {
    this.turns = turns.map((t, i) => ({ ...t, at: t.at ?? i, speaker: t.speaker || "speaker", date: t.date || "" }));
    this.episodic = this.turns.map(formatTurn);
    this.epiPos = new Map(this.episodic.map((e, i) => [e, i]));
    this.buildBodyIndex();
    this.buildGraph();
    this.buildTemporal();
    this.buildProfiles();
    this.buildSalience();
    for (const t of this.turns) {
      const dated = t.date ? `${t.speaker}: [${t.date}] ${t.text}` : `${t.speaker}: ${t.text}`;
      this.semantic.observe([{ role: "user", content: dated }]);
    }
  }

  /** Ingest plain chat strings (`Speaker: text`) without dates. */
  ingestTexts(texts: string[]) {
    this.ingestTurns(
      texts.map((raw, i) => {
        const m = raw.match(/^([A-Za-z][A-Za-z0-9 /._-]{0,32}):\s*([\s\S]+)$/);
        return m ? { speaker: m[1], text: m[2]!.trim(), at: i } : { speaker: "speaker", text: raw.trim(), at: i };
      }),
    );
  }

  /** Episodic pattern completion: index turn bodies so a trimmed cortical note can be re-bound to its full episode. */
  private buildBodyIndex() {
    this.bodyIndex.clear();
    this.canonCache.clear();
    for (let i = 0; i < this.turns.length; i++) {
      const key = bodyKey(this.turns[i]!.text || "");
      if (!key) continue;
      const list = this.bodyIndex.get(key);
      if (list) list.push(i);
      else this.bodyIndex.set(key, [i]);
    }
  }

  /** Map a semantic note back to the episodic turn it was distilled from (full turn wins: more context, one node id). */
  private canon(note: string): string {
    const hit = this.canonCache.get(note);
    if (hit !== undefined) return hit;
    let out = note;
    const body = noteBody(note);
    const cands = this.bodyIndex.get(bodyKey(body));
    if (cands) {
      for (const i of cands) {
        const full = (this.turns[i]!.text || "").replace(/\s+/g, " ").trim();
        if (full === body || full.startsWith(body) || full.includes(body)) {
          out = this.episodic[i]!;
          break;
        }
      }
    }
    this.canonCache.set(note, out);
    return out;
  }

  private buildGraph() {
    this.graph.clear();
    this.noteToks = this.episodic.map((n) => toks(n));
    this.noteSets = this.noteToks.map((t) => new Set(t));
    this.epiIx = bm25Index(this.noteToks);
    const link = (a: string, b: string, w = 1) => {
      if (a === b) return;
      if (!this.graph.has(a)) this.graph.set(a, new Map());
      const m = this.graph.get(a)!;
      m.set(b, (m.get(b) || 0) + w);
    };
    for (let ti = 0; ti < this.noteToks.length; ti++) {
      const ts = this.noteToks[ti]!;
      const uniq = [...new Set(ts.filter((w) => w.length >= 3))];
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < Math.min(i + 12, uniq.length); j++) {
          link(uniq[i]!, uniq[j]!);
          link(uniq[j]!, uniq[i]!);
        }
      }
      // Entity hubs: speaker name strongly binds to turn content (cortical association).
      const sp = (this.turns[ti]?.speaker || "").toLowerCase();
      if (sp.length >= 3) {
        for (const w of uniq) {
          if (w === sp) continue;
          link(sp, w, 3);
          link(w, sp, 3);
        }
      }
    }
  }

  /** Temporal cue enrichment — months/years from the question + matching session stamps. */
  private whenQuery(q: string): string {
    const extra: string[] = [];
    for (const y of q.match(/\b20\d{2}\b/g) || []) extra.push(y);
    for (const m of q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi) || []) {
      extra.push(m.toLowerCase());
    }
    for (const t of this.turns) {
      if (!t.date) continue;
      const dt = t.date.toLowerCase();
      if (extra.some((e) => e.length >= 3 && dt.includes(e))) extra.push(...dateTokens(t.date));
    }
    const u = [...new Set(extra)];
    return u.length ? `${q} ${u.join(" ")}` : q;
  }

  private buildTemporal() {
    const dim = 64;
    let state = new Array(dim).fill(0);
    this.ctx = [];
    for (const t of this.turns) {
      const next = state.map((x) => x * 0.92);
      for (const w of toks(t.text || "").concat(toks(t.speaker || "")).concat(dateTokens(t.date || ""))) {
        let h = 0;
        for (let c = 0; c < w.length; c++) h = (h * 31 + w.charCodeAt(c)) | 0;
        next[Math.abs(h) % dim] += 1;
      }
      state = next;
      this.ctx.push(state.slice());
    }
  }

  private buildProfiles() {
    this.profiles.clear();
    for (const t of this.turns) {
      const sp = (t.speaker || "speaker").toLowerCase();
      if (!this.profiles.has(sp)) this.profiles.set(sp, []);
      const line = (t.text || "").trim();
      if (line.length >= 40 && !/^(hey|hi|hello|thanks|thank you|lol|haha)\b/i.test(line)) {
        this.profiles.get(sp)!.push(formatTurn(t));
      }
    }
    for (const [sp, lines] of this.profiles) {
      this.profiles.set(sp, [...lines].sort((a, b) => b.length - a.length).slice(0, 40));
    }
  }

  private buildSalience() {
    const df = new Map<string, number>();
    for (const ts of this.noteToks) {
      for (const w of new Set(ts)) df.set(w, (df.get(w) || 0) + 1);
    }
    const N = this.episodic.length || 1;
    this.sal = this.episodic.map((n, i) => {
      let rare = 0;
      for (const w of new Set(this.noteToks[i]!)) {
        if ((df.get(w) || 1) / N < 0.05) rare += 1;
      }
      return rare * 0.8 + properNames(n).length * 1.2 + (n.match(/\d+/g) || []).length * 0.9 + Math.min(1, n.length / 200);
    });
  }

  private asaRetrieve(q: string, k: number): string[] {
    const act = new Map<string, number>();
    for (const w of toks(q)) act.set(w, (act.get(w) || 0) + 1);
    // Proper names / speakers get stronger seed activation (entity hubs).
    for (const n of properNames(q)) act.set(n.toLowerCase(), (act.get(n.toLowerCase()) || 0) + 2);
    const spread = new Map(act);
    for (const [w, a] of act) {
      const nbr = this.graph.get(w);
      if (!nbr) continue;
      for (const [v, wt] of nbr) spread.set(v, (spread.get(v) || 0) + a * Math.min(1.5, wt / 3) * 0.4);
    }
    // 2-hop from high-activation entity hubs only
    const hubs = [...spread.entries()].filter(([w, a]) => a >= 1.2 && w.length >= 4).slice(0, 8);
    for (const [w, a] of hubs) {
      const nbr = this.graph.get(w);
      if (!nbr) continue;
      for (const [v, wt] of nbr) {
        if (spread.has(v)) continue;
        spread.set(v, a * Math.min(1, wt / 5) * 0.15);
      }
    }
    return this.episodic
      .map((d, i) => {
        let s = 0;
        for (const w of this.noteToks[i]!) s += spread.get(w) || 0;
        return { d, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.d);
  }

  private tcmRetrieve(q: string, k: number): string[] {
    const qTok = toks(q);
    const qDate = dateTokens(q);
    const dim = 64;
    const probe = new Array(dim).fill(0);
    for (const w of qTok) {
      let h = 0;
      for (let c = 0; c < w.length; c++) h = (h * 31 + w.charCodeAt(c)) | 0;
      probe[Math.abs(h) % dim] += 1;
    }
    const cos = (a: number[], b: number[]) => {
      let dp = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        dp += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return dp / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
    };
    return this.episodic
      .map((d, i) => {
        const hay = this.noteSets[i]!;
        let lex = 0;
        for (const w of qTok) if (hay.has(w)) lex += 1;
        for (const w of qDate) if (hay.has(w)) lex += 2;
        return { d, s: lex + 2.5 * cos(probe, this.ctx[i] || probe) };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.d);
  }

  private epiBm25(q: string, k: number): string[] {
    return topK(this.episodic, bm25Scores(q, this.epiIx!), k);
  }

  private schemaRetrieve(q: string, k: number): string[] {
    const qNames = properNames(q).map((n) => n.toLowerCase());
    const profileHits: string[] = [];
    for (const name of qNames) {
      const lines = this.profiles.get(name);
      if (lines?.length) profileHits.push(...bm25(q, lines, 8));
    }
    return rrfFuse([profileHits, this.epiBm25(q, 12)], k);
  }

  private salienceRetrieve(q: string, k: number): string[] {
    const qTok = toks(q);
    return this.episodic
      .map((d, i) => {
        const hay = this.noteSets[i]!;
        let lex = 0;
        for (const w of qTok) if (hay.has(w)) lex += 1;
        return { d, s: lex + 0.35 * (this.sal[i] || 0) };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.d);
  }

  retrieve(q: string, k = 6): string[] {
    if (!this.episodic.length) return this.retrieveCore(q, k);
    return this.retrieveCore(q, k).map((d) => this.chunk(d));
  }

  /**
   * Episodic chunk reconstruction: a hit is re-bound to its same-session dialogue
   * neighbours (prev, hit, next). A query usually matches the turn that *asks*, while
   * the answer lives in the reply — temporal-context binding returns the pair as one unit.
   */
  private chunk(d: string): string {
    const i = this.epiPos.get(d);
    if (i === undefined) return d;
    const sess = this.turns[i]!.session;
    const parts = [d];
    if (i + 1 < this.turns.length && this.turns[i + 1]!.session === sess) parts.push(this.episodic[i + 1]!);
    if (i > 0 && this.turns[i - 1]!.session === sess) parts.unshift(this.episodic[i - 1]!);
    return parts.join("\n");
  }

  private retrieveCore(q: string, k = 6): string[] {
    if (!this.episodic.length) return this.semantic.notesFor(q, k).map((m) => m.text);
    const whenQ = /\b(when|date|year|month|ago|yesterday|last week|before|after)\b/i.test(q);
    // Date cues without "when" still get temporal enrichment (year/month in Q).
    const dateCue = /\b20\d{2}\b/.test(q) || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(q);
    const eden = uniq(this.semantic.notesFor(q, 20).map((m) => this.canon(m.text)));
    const qEp = whenQ || dateCue ? this.whenQuery(q) : q;
    const epiBm25 = this.epiBm25(qEp, 24);
    if (whenQ) {
      const tcm = this.tcmRetrieve(qEp, 24);
      const dated = [...tcm, ...epiBm25].filter((n) => /\[[^\]]*\]/.test(n) || /\b20\d{2}\b/.test(n));
      const asa = this.asaRetrieve(q, 12);
      const fused = rrfFuse([dated, dated, tcm, epiBm25, asa, eden], k);
      // Light Eden pin on when-path — keeps cortex gist without burying TCM.
      const pin = eden.slice(0, 2).filter(Boolean);
      if (pin.length) {
        const rest = fused.filter((d) => !pin.includes(d));
        return [...pin, ...rest].slice(0, k);
      }
      return fused;
    }
    const sch = this.schemaRetrieve(q, 12);
    const asa = this.asaRetrieve(q, 12);
    const fused = rrfFuse([eden, eden, epiBm25, sch, asa], k);
    // Pin Eden's top semantic hits so cortex gist is never buried by episodic noise.
    const pin = eden.slice(0, 5).filter(Boolean);
    if (pin.length) {
      const rest = fused.filter((d) => !pin.includes(d));
      return [...pin, ...rest].slice(0, k);
    }
    return fused;
  }

  /** Inject block for agent prompts. */
  injectBlock(q: string, k = 6): string {
    const notes = this.retrieve(q, k);
    if (!notes.length) return "";
    return `Eden Brain Memory:\n${notes.map((n) => `- ${n}`).join("\n")}`;
  }

  stored(): string[] {
    return this.episodic.slice();
  }

  close() {
    this.semantic.close();
  }
}

export function openBrainMemory(opts: { dir?: string } = {}): BrainMemory {
  return new BrainMemory(opts);
}
