/**
 * IclIndex: one record per ICL exemplar (M19.1).
 * Report §4.2 — Mem0 MCC 32.4 (extract destroys ICL). Store-all including
 * `label:`. Diversity at k=10 so 100 same-class near-dups cannot crowd out a
 * singleton other-class gold. No graph, no extract, no label-strip, no 512-chunk.
 * Persist on the memory root as icl.jsonl. Fail-open: never throw into inject.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { scrubMemoryText } from "./memory-scrub";

export const ICL_RETRIEVE_K = 10;

/** Robertson / Lucene BM25. Local copy — hay retrieve is banned. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Jaccard/stem near-dup: clones fill k; gold vs majority is ~0.76 so stays below. */
const NEAR_DUP = 0.8;

export type IclRecord = { id: string; text: string; t: number; src?: string; label?: string };

export type IclHit = { text: string; id: string; t: number; score: number; label?: string; src?: string };

export type IclFallback = { text?: string; id?: string; at?: number; lane?: string };

const FILE = "icl.jsonl";
/** Inline secret shapes — do not extract or redact shots through the IR path. */
const SECRET_INLINE = /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9/_-]+/g;
const LABEL_RE = /\blabel\s*:\s*(\S+)/i;
const OUTPUT_RE = /\boutput\s*:\s*(\S+)/i;

function scrub(text: string): string {
  let s = scrubMemoryText(String(text ?? ""));
  SECRET_INLINE.lastIndex = 0;
  return s.replace(SECRET_INLINE, "[secret]");
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `icl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function stripPunct(raw: string): string {
  return raw.replace(/[.,;:!?]+$/g, "");
}

/** Parse class for diversity. Keep `label:` in stored text; this is metadata only. */
function parseLabel(text: string): string | undefined {
  const t = String(text ?? "");
  const lab = t.match(LABEL_RE);
  if (lab?.[1]) {
    const v = stripPunct(lab[1]);
    if (v) return v;
  }
  const out = t.match(OUTPUT_RE);
  if (out?.[1]) {
    const v = stripPunct(out[1]);
    if (v) return v;
  }
  return undefined;
}

function labelKey(lab?: string): string {
  return String(lab ?? "")
    .trim()
    .toLowerCase();
}

function looksLikeExemplar(text: string): boolean {
  const t = String(text ?? "");
  return LABEL_RE.test(t) || /\b(?:input|output)\s*:/i.test(t);
}

function asRecord(v: unknown): IclRecord | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const text = typeof o.text === "string" ? o.text : "";
  if (!id || !text) return null;
  const t = typeof o.t === "number" && Number.isFinite(o.t) ? o.t : 0;
  const row: IclRecord = { id, text, t };
  if (typeof o.src === "string" && o.src) row.src = o.src;
  const lab = typeof o.label === "string" && o.label ? o.label : parseLabel(text);
  if (lab) row.label = lab;
  return row;
}

function load(path: string): IclRecord[] {
  if (!existsSync(path)) return [];
  const out: IclRecord[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const row = asRecord(JSON.parse(line));
        if (row) out.push(row);
      } catch {
        // Torn or invalid line — skip.
      }
    }
  } catch {}
  return out;
}

function persist(path: string, rows: IclRecord[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileAtomic(path, body);
  try {
    chmodSync(path, 0o600);
  } catch {}
}

function mint(text: string, opts?: { src?: string; t?: number }): IclRecord[] {
  const body = scrub(text).trim();
  if (!body) return [];
  const src = typeof opts?.src === "string" ? opts.src.trim() : "";
  const n = Number(opts?.t);
  const t = Number.isFinite(n) ? n : Date.now();
  const row: IclRecord = { id: newId(), text: body, t };
  if (src) row.src = src;
  const lab = parseLabel(body);
  if (lab) row.label = lab;
  return [row];
}

function takeK(requested?: number): number {
  const n = Number(requested);
  const want = Number.isFinite(n) && n > 0 ? Math.floor(n) : ICL_RETRIEVE_K;
  return Math.min(ICL_RETRIEVE_K, want);
}

/** Local copy of narrative `tokList`. No FOLD (hours→tz would poison shots). */
function tokList(s: string): string[] {
  return (
    String(s ?? "")
      .toLowerCase()
      .match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? []
  );
}

function stem(w: string): string {
  if (w.length <= 3) return w;
  return w.replace(/(?:ingly|edly|ing|ed|ly|es|s)$/i, "") || w;
}

function stemSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of tokList(text)) {
    const s = stem(w);
    if (s) out.add(s);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

type Scored = { rec: IclRecord; score: number; toks: Set<string> };

/**
 * Okapi BM25 over every doc (including score 0). Rank ALL — do not slice to k
 * before diversity or gold at rank 11 is lost.
 */
function bm25All(query: string, docs: string[]): number[] {
  const qToks = tokList(query);
  const N = docs.length;
  const scores = new Array<number>(N).fill(0);
  if (!qToks.length || !N) return scores;
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
  for (let i = 0; i < N; i++) {
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
    scores[i] = s;
  }
  return scores;
}

function labelsDiffer(a: IclRecord, b: IclRecord): boolean {
  const la = labelKey(a.label);
  const lb = labelKey(b.label);
  return !!la && !!lb && la !== lb;
}

function isNearDup(row: Scored, picked: Scored[]): boolean {
  for (const p of picked) {
    if (labelsDiffer(row.rec, p.rec)) continue;
    if (jaccard(row.toks, p.toks) >= NEAR_DUP) return true;
  }
  return false;
}

/**
 * 1. Unique labels first (walk BM25 order) so one other-class shot cannot be
 *    crowded out by 100 same-class near-dups. Jaccard does not apply here —
 *    gold and majority share most tokens.
 * 2. Jaccard/stem near-dup suppress so k is not clones.
 *    Different labels are not clones. Do not refill slots with suppressed rows.
 */
function diversify(ranked: Scored[], k: number): Scored[] {
  const picked: Scored[] = [];
  const seenId = new Set<string>();
  const seenLab = new Set<string>();

  for (const row of ranked) {
    if (picked.length >= k) break;
    const lab = labelKey(row.rec.label);
    if (!lab || seenLab.has(lab)) continue;
    picked.push(row);
    seenId.add(row.rec.id);
    seenLab.add(lab);
  }

  for (const row of ranked) {
    if (picked.length >= k) break;
    if (seenId.has(row.rec.id)) continue;
    if (isNearDup(row, picked)) continue;
    picked.push(row);
    seenId.add(row.rec.id);
  }

  picked.sort((a, b) => b.score - a.score || a.rec.t - b.rec.t);
  return picked;
}

function toHit(row: Scored): IclHit {
  const hit: IclHit = {
    text: row.rec.text,
    id: row.rec.id,
    t: row.rec.t,
    score: row.score,
  };
  if (row.rec.label) hit.label = row.rec.label;
  if (row.rec.src) hit.src = row.rec.src;
  return hit;
}

function fallbackDocs(rows: IclFallback[] | undefined): IclRecord[] {
  if (!Array.isArray(rows) || !rows.length) return [];
  const out: IclRecord[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const text = String(row.text ?? "").trim();
    if (!text) continue;
    const lane = typeof row.lane === "string" ? row.lane : "";
    if (lane !== "icl" && !looksLikeExemplar(text)) continue;
    const t = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : 0;
    const rec: IclRecord = {
      id: typeof row.id === "string" && row.id ? row.id : `icl-fb:${i}`,
      text,
      t,
    };
    const lab = parseLabel(text);
    if (lab) rec.label = lab;
    out.push(rec);
  }
  return out;
}

function rankHits(rows: IclRecord[], cue: string, k: number): IclHit[] {
  if (!rows.length || !k) return [];
  const scores = bm25All(
    cue,
    rows.map((r) => r.text),
  );
  const ranked: Scored[] = rows.map((rec, i) => ({
    rec,
    score: scores[i] ?? 0,
    toks: stemSet(rec.text),
  }));
  ranked.sort((a, b) => b.score - a.score || a.rec.t - b.rec.t || (a.rec.id < b.rec.id ? -1 : 1));
  return diversify(ranked, k).map(toHit);
}

export class IclIndex {
  readonly dir: string;
  readonly path: string;
  private readonly lockPath: string;

  constructor(dir: string) {
    this.dir = String(dir ?? "");
    this.path = join(this.dir, FILE);
    this.lockPath = `${this.path}.lock`;
    try {
      mkdirSync(this.dir, { recursive: true });
      try {
        chmodSync(this.dir, 0o700);
      } catch {}
    } catch {}
  }

  /** One exemplar = one record. Do not 512-chunk. Fail-open: never throw. */
  put(text: string, opts?: { src?: string; t?: number }): IclRecord[] {
    try {
      const minted = mint(String(text ?? ""), opts);
      if (!minted.length) return [];
      const src = minted[0]!.src;
      try {
        withFileLock(this.lockPath, () => {
          const rows = src ? load(this.path).filter((c) => c.src !== src) : load(this.path);
          rows.push(...minted);
          persist(this.path, rows);
        });
      } catch {
        // Fail-open: lock/disk faults must not throw into inject.
      }
      return minted;
    } catch {
      return [];
    }
  }

  /** All exemplars. Fail-open: [] */
  all(): IclRecord[] {
    try {
      return load(this.path);
    } catch {
      return [];
    }
  }
}

/**
 * BM25 + label diversity over persisted exemplars, else in-memory fallback.
 * Empty cue → no dump. k = min(10, requested). Never throws.
 */
export function retrieveIcl(dir: string, cue: string, opts?: { k?: number; fallback?: IclFallback[] }): IclHit[] {
  try {
    const q = String(cue ?? "").trim();
    if (!q) return [];
    const k = takeK(opts?.k);
    if (!k) return [];
    let rows: IclRecord[] = [];
    try {
      rows = new IclIndex(dir).all();
    } catch {
      rows = [];
    }
    if (!rows.length) rows = fallbackDocs(opts?.fallback);
    if (!rows.length) return [];
    return rankHits(rows, q, k);
  } catch {
    return [];
  }
}
