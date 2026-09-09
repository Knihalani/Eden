/**
 * CLS controller: classifies the query (episodic recall / semantic lookup / temporal),
 * runs the episodic + semantic stores and the Eden cortex lane, fuses them with a
 * calibrated (learned-free) combiner, applies supersession (newest wins) and returns
 * compact answer units with their provenance dialogue only when it helps.
 */
import type { AgentMemory } from "../index";
import { EpisodicStore, type Cue, type Episode } from "./episodic";
import { SemanticStore } from "./semantic";
import { MONTHS, contentToks } from "./text";

export type QueryKind = { temporal: boolean; semantic: boolean; frame: ReturnType<typeof SemanticStore.frameOf>; entities: string[] };

const W = {
  epi: Number(process.env.CLS_W_EPI ?? 1.0),
  sem: Number(process.env.CLS_W_SEM ?? 0.6),
  cortex: Number(process.env.CLS_W_CORTEX ?? 1.05),
  agree: Number(process.env.CLS_W_AGREE ?? 0.15),
  qa: Number(process.env.CLS_QA ?? 0.45),
  rounds: Number(process.env.CLS_ROUNDS ?? 3),
  decay: Number(process.env.CLS_DECAY ?? 0.35),
  temporal: Number(process.env.CLS_TEMPORAL ?? 0.25),
};

function bodyKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 24);
}

export class CLSController {
  readonly epi = new EpisodicStore();
  readonly sem = new SemanticStore();
  private bodyIndex = new Map<string, number[]>();
  private canonCache = new Map<string, number>();

  constructor(private cortex: AgentMemory) {}

  ingest(turns: { text: string; speaker?: string; date?: string; session?: number; at?: number }[]) {
    this.epi.ingest(turns);
    this.sem.compile(this.epi.episodes);
    this.bodyIndex.clear();
    this.canonCache.clear();
    for (const e of this.epi.episodes) {
      const k = bodyKey(e.text);
      if (!k) continue;
      const l = this.bodyIndex.get(k);
      if (l) l.push(e.i);
      else this.bodyIndex.set(k, [e.i]);
    }
    for (const e of this.epi.episodes) {
      const dated = e.date ? `${e.speaker}: [${e.date}] ${e.text}` : `${e.speaker}: ${e.text}`;
      this.cortex.observe([{ role: "user", content: dated }]);
    }
  }

  /** Map a cortex note back to its provenance episode (pattern completion from a trimmed cue). */
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
      // Fallback: strongest lexical match on the body text.
      const cue = this.epi.cueFor(body);
      const top = this.epi.topK(this.epi.score(cue), 1);
      if (top.length) out = top[0]!.i;
    }
    this.canonCache.set(note, out);
    return out;
  }

  classify(q: string): QueryKind {
    const low = q.toLowerCase();
    const temporal = /\b(when|what time|what day|what date|which day|what year|what month|how long ago|date|year|month|ago|yesterday|last week|before|after)\b/.test(low) || /\b20\d{2}\b/.test(low) || MONTHS.some((m) => new RegExp(`\\b${m}\\b`).test(low));
    const frame = SemanticStore.frameOf(q);
    const entities = (q.match(/\b[A-Z][a-z]{2,16}\b/g) ?? []).map((x) => x.toLowerCase());
    const semantic = frame !== null || /\b(is|are|does|do|has|have)\b/.test(low);
    return { temporal, semantic, frame, entities };
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

  /** Dialogue binding: a reply inherits part of the question turn's activation and vice versa. */
  private bindQA(s: Float64Array): Float64Array {
    const eps = this.epi.episodes;
    const out = new Float64Array(s.length);
    for (let i = 0; i < s.length; i++) {
      let v = s[i]!;
      const prev = i > 0 && eps[i - 1]!.session === eps[i]!.session ? eps[i - 1]! : undefined;
      const next = i + 1 < s.length && eps[i + 1]!.session === eps[i]!.session ? eps[i + 1]! : undefined;
      if (prev && prev.isQuestion) v += W.qa * s[i - 1]!;
      if (next && eps[i]!.isQuestion) v += W.qa * 0.6 * s[i + 1]!;
      out[i] = v;
    }
    return out;
  }

  /** Fused scores for every episode. */
  scores(q: string): Float64Array {
    const n = this.epi.size();
    const kind = this.classify(q);
    const cue: Cue = this.epi.cueFor(q, { timeW: kind.temporal ? 2 : 1.5 });
    const base = this.epi.score(cue);
    const epiRaw = W.rounds > 1 ? this.epi.complete(cue, { rounds: W.rounds, decay: W.decay, scores: base }) : base;
    const epi = this.norm(this.bindQA(epiRaw), n);
    const sem = this.norm(this.sem.lookup(q), n);
    const cortexMap = new Map<number, number>();
    const notes = this.cortex.notesFor(q, 20);
    notes.forEach((m, r) => {
      const i = this.canon(m.text);
      if (i >= 0) cortexMap.set(i, Math.max(cortexMap.get(i) || 0, 1 / (1 + 0.35 * r)));
    });
    const cortex = this.norm(cortexMap, n);
    const fused = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = epi[i]!, b = sem[i]!, c = cortex[i]!;
      if (!a && !b && !c) continue;
      const lanes = (a > 0 ? 1 : 0) + (b > 0 ? 1 : 0) + (c > 0 ? 1 : 0);
      let v = W.epi * a + W.sem * b + W.cortex * c + W.agree * (lanes - 1);
      if (kind.temporal) {
        const e = this.epi.episodes[i]!;
        if (e.grounded.length || /\b20\d{2}\b/.test(e.text)) v *= 1 + W.temporal;
      }
      fused[i] = v;
    }
    // Supersession: a superseded fact hands its activation to its successor (newest wins).
    for (const f of this.sem.facts) {
      if (f.supersededBy === undefined) continue;
      const old = f.ep, nu = f.supersededBy;
      if (fused[old]! <= 0) continue;
      fused[nu] = Math.max(fused[nu]!, fused[old]! * 1.05 + 1e-6);
      fused[old] = fused[old]! * 0.45;
    }
    return fused;
  }

  /** Compact answer unit: the episode plus provenance dialogue when the turn is a question / reply. */
  chunk(e: Episode, full: boolean): string {
    const { prev, next } = this.epi.neighbours(e.i);
    const parts = [e.render];
    if (full) {
      if (next) parts.push(next.render);
      if (prev) parts.unshift(prev.render);
      return parts.join("\n");
    }
    if (next && e.isQuestion) parts.push(next.render);
    if (prev && (prev.isQuestion || contentToks(e.text).length < 6)) parts.unshift(prev.render);
    return parts.join("\n");
  }

  retrieve(q: string, k: number, opts: { full?: boolean } = {}): string[] {
    if (!this.epi.size()) return this.cortex.notesFor(q, k).map((m) => m.text);
    const fused = this.scores(q);
    const top = this.epi.topK(fused, k);
    return top.map((h) => this.chunk(this.epi.episodes[h.i]!, opts.full ?? true));
  }
}
