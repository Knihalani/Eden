/**
 * Five brain-inspired memory POCs + synthesized Hippocampal–Cortical Memory (HCM).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../../src/index";
import { type MemSys, type Turn, bm25, dateTokens, formatTurn, properNames, rrfFuse, toks } from "./shared";

const SPEAKER_RE = /^([A-Za-z][A-Za-z0-9 /._-]{0,32}):/;

function bodyOf(note: string): string {
  return note
    .replace(SPEAKER_RE, "")
    .replace(/\[[^\]]+\]/, "")
    .trim();
}

/* ─── 1. Associative Spreading Activation ─────────────────────────────── */

export class AsaSys implements MemSys {
  id = "asa";
  notes: string[] = [];
  /** undirected weighted co-occurrence */
  graph = new Map<string, Map<string, number>>();
  noteToks: string[][] = [];

  ingest(turns: Turn[]) {
    this.notes = turns.map(formatTurn);
    this.noteToks = this.notes.map((n) => toks(n));
    this.graph.clear();
    const link = (a: string, b: string) => {
      if (a === b) return;
      if (!this.graph.has(a)) this.graph.set(a, new Map());
      const m = this.graph.get(a)!;
      m.set(b, (m.get(b) || 0) + 1);
    };
    for (const ts of this.noteToks) {
      const uniq = [...new Set(ts.filter((w) => w.length >= 3))];
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < Math.min(i + 12, uniq.length); j++) {
          link(uniq[i]!, uniq[j]!);
          link(uniq[j]!, uniq[i]!);
        }
      }
    }
  }

  retrieve(q: string, k = 5): string[] {
    const act = new Map<string, number>();
    for (const w of toks(q)) act.set(w, (act.get(w) || 0) + 1);
    // one-hop spread
    const spread = new Map(act);
    for (const [w, a] of act) {
      const nbr = this.graph.get(w);
      if (!nbr) continue;
      for (const [v, wt] of nbr) spread.set(v, (spread.get(v) || 0) + a * Math.min(1, wt / 4) * 0.35);
    }
    return this.notes
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

  stored() {
    return this.notes.slice();
  }
}

/* ─── 2. Temporal Context Model (+ session dates) ─────────────────────── */

export class TcmSys implements MemSys {
  id = "tcm";
  notes: string[] = [];
  turns: Turn[] = [];
  /** decaying temporal context fingerprint per turn */
  ctx: number[][] = [];

  ingest(turns: Turn[]) {
    this.turns = turns;
    this.notes = turns.map(formatTurn);
    const dim = 64;
    let state = new Array(dim).fill(0);
    this.ctx = [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!;
      const next = state.map((x) => x * 0.92);
      for (const w of toks(t.text).concat(toks(t.speaker)).concat(dateTokens(t.date))) {
        let h = 0;
        for (let c = 0; c < w.length; c++) h = (h * 31 + w.charCodeAt(c)) | 0;
        const idx = Math.abs(h) % dim;
        next[idx] += 1;
      }
      state = next;
      this.ctx.push(state.slice());
    }
  }

  retrieve(q: string, k = 5): string[] {
    const qTok = toks(q);
    const qDate = dateTokens(q);
    // build query temporal probe from lexical + any date words in question
    const dim = 64;
    const probe = new Array(dim).fill(0);
    for (const w of qTok) {
      let h = 0;
      for (let c = 0; c < w.length; c++) h = (h * 31 + w.charCodeAt(c)) | 0;
      probe[Math.abs(h) % dim] += 1;
    }
    const cos = (a: number[], b: number[]) => {
      let dp = 0,
        na = 0,
        nb = 0;
      for (let i = 0; i < a.length; i++) {
        dp += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return dp / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
    };
    return this.notes
      .map((d, i) => {
        const hay = new Set(toks(d));
        let lex = 0;
        for (const w of qTok) if (hay.has(w)) lex += 1;
        for (const w of qDate) if (hay.has(w)) lex += 2;
        const temp = cos(probe, this.ctx[i]!);
        return { d, s: lex + 2.5 * temp };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.d);
  }

  stored() {
    return this.notes.slice();
  }
}

/* ─── 3. Complementary Learning Systems (episodic + Eden semantic) ────── */

export class ClsSys implements MemSys {
  id = "cls";
  episodic: string[] = [];
  dir: string;
  semanticTexts: string[] = [];

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "cls-"));
  }

  ingest(turns: Turn[]) {
    this.episodic = turns.map(formatTurn);
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {}
    this.dir = mkdtempSync(join(tmpdir(), "cls-"));
    const mem = openMemory({ dir: this.dir });
    for (const t of turns) mem.observe([{ role: "user", content: `${t.speaker}: ${t.text}` }]);
    this.semanticTexts = mem.memories().map((m) => m.text);
    mem.close();
  }

  retrieve(q: string, k = 5): string[] {
    const epi = bm25(q, this.episodic, Math.max(k, 15));
    const mem = openMemory({ dir: this.dir });
    // re-seed for notesFor path
    const sem = mem.notesFor(q, Math.max(k, 15)).map((m) => m.text);
    mem.close();
    return rrfFuse([epi, sem], k);
  }

  stored() {
    return [...this.episodic, ...this.semanticTexts];
  }
}

/* ─── 4. Schema + Exemplar (speaker profiles) ─────────────────────────── */

export class SchemaSys implements MemSys {
  id = "schema";
  exemplars: string[] = [];
  profiles = new Map<string, string[]>();

  ingest(turns: Turn[]) {
    this.exemplars = turns.map(formatTurn);
    this.profiles.clear();
    for (const t of turns) {
      const sp = t.speaker.toLowerCase();
      if (!this.profiles.has(sp)) this.profiles.set(sp, []);
      const line = t.text.trim();
      // keep substantive lines in profile (schema gist)
      if (line.length >= 40 && !/^(hey|hi|hello|thanks|thank you|lol|haha)\b/i.test(line)) {
        this.profiles.get(sp)!.push(`${t.speaker}: ${line}`);
      }
    }
    // cap profile size — keep longest (more content) lines
    for (const [sp, lines] of this.profiles) {
      this.profiles.set(sp, [...lines].sort((a, b) => b.length - a.length).slice(0, 40));
    }
  }

  retrieve(q: string, k = 5): string[] {
    const qNames = properNames(q).map((n) => n.toLowerCase());
    const profileHits: string[] = [];
    for (const name of qNames) {
      const lines = this.profiles.get(name);
      if (lines) profileHits.push(...bm25(q, lines, 8));
    }
    const ex = bm25(q, this.exemplars, Math.max(k, 12));
    return rrfFuse([profileHits, ex], k);
  }

  stored() {
    const prof = [...this.profiles.values()].flat();
    return [...this.exemplars, ...prof];
  }
}

/* ─── 5. Salience-Weighted Consolidation ──────────────────────────────── */

export class SalienceSys implements MemSys {
  id = "salience";
  notes: string[] = [];
  sal: number[] = [];
  df = new Map<string, number>();

  ingest(turns: Turn[]) {
    this.notes = turns.map(formatTurn);
    this.df.clear();
    const tfs = this.notes.map((n) => toks(n));
    for (const ts of tfs) {
      const seen = new Set(ts);
      for (const w of seen) this.df.set(w, (this.df.get(w) || 0) + 1);
    }
    const N = this.notes.length || 1;
    this.sal = this.notes.map((n, i) => {
      const ts = tfs[i]!;
      let rare = 0;
      for (const w of new Set(ts)) {
        const d = this.df.get(w) || 1;
        if (d / N < 0.05) rare += 1;
      }
      const names = properNames(bodyOf(n)).length;
      const digits = (n.match(/\d+/g) || []).length;
      const len = Math.min(1, n.length / 200);
      return rare * 0.8 + names * 1.2 + digits * 0.9 + len;
    });
  }

  retrieve(q: string, k = 5): string[] {
    const qTok = toks(q);
    return this.notes
      .map((d, i) => {
        const hay = new Set(toks(d));
        let lex = 0;
        for (const w of qTok) if (hay.has(w)) lex += 1;
        return { d, s: lex + 0.35 * this.sal[i]! };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.d);
  }

  stored() {
    return this.notes.slice();
  }
}

/* ─── Synthesis: Hippocampal–Cortical Memory (HCM) ────────────────────── */

/**
 * Full system: dated episodic store + Eden semantic + speaker schemas +
 * spreading activation + salience prior, fused via RRF.
 */
export class HcmSys implements MemSys {
  id = "hcm";
  episodic: string[] = [];
  turns: Turn[] = [];
  asa = new AsaSys();
  tcm = new TcmSys();
  schema = new SchemaSys();
  salience = new SalienceSys();
  dir: string;
  semanticReady = false;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "hcm-"));
  }

  ingest(turns: Turn[]) {
    this.turns = turns;
    this.episodic = turns.map(formatTurn);
    this.asa.ingest(turns);
    this.tcm.ingest(turns);
    this.schema.ingest(turns);
    this.salience.ingest(turns);
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {}
    this.dir = mkdtempSync(join(tmpdir(), "hcm-"));
    const mem = openMemory({ dir: this.dir });
    for (const t of turns) {
      // Feed dated speaker turns into Eden extract (semantic cortex)
      mem.observe([{ role: "user", content: `${t.speaker}: [${t.date}] ${t.text}` }]);
    }
    mem.close();
    this.semanticReady = true;
  }

  retrieve(q: string, k = 5): string[] {
    const whenQ = /\b(when|date|year|month|ago|yesterday|last week|before|after)\b/i.test(q);
    const epiBm25 = bm25(q, this.episodic, 20);
    const asa = this.asa.retrieve(q, 12);
    const tcm = this.tcm.retrieve(q, 20);
    const sch = this.schema.retrieve(q, 12);
    let sem: string[] = [];
    if (this.semanticReady) {
      const mem = openMemory({ dir: this.dir });
      sem = mem.notesFor(q, 20).map((m) => m.text);
      mem.close();
    }
    if (whenQ) {
      const dated = [...tcm, ...epiBm25].filter((n) => /\[[^\]]*\]/.test(n) || /\b20\d{2}\b/.test(n));
      return rrfFuse([dated, tcm, epiBm25, sem], k);
    }
    return rrfFuse([sem, sem, epiBm25, sch, asa], k);
  }

  stored() {
    return this.episodic.slice();
  }
}

export function makeAllSystems(): MemSys[] {
  return [new AsaSys(), new TcmSys(), new ClsSys(), new SchemaSys(), new SalienceSys(), new HcmSys()];
}
