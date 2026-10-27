/**
 * ChunkStore: sentence-preserving ~512-token narrative chunks (M18.1).
 * EventQA / Gate 2: BM25 on these chunks, not 4096 extracted packs. Not GraphRAG.
 * Store-all — this module does not extract. Persist on the memory root as
 * chunks.jsonl (like gists/howto), not a session subdir. Fail-open.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { scrubMemoryText } from "./memory-scrub";

export const CHUNK_TARGET_TOKENS = 512;

export type NarrativeChunk = {
  id: string;
  text: string;
  i: number;
  src?: string;
  t: number;
};

const FILE = "chunks.jsonl";
/** Inline secret shapes — do not run the IR redactor over novels. */
const SECRET_INLINE = /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9/_-]+/g;

/** Count `[a-z0-9]+` matches; fall back to whitespace words when none. */
export function estimateTokens(text: string): number {
  const s = String(text ?? "");
  if (!s.trim()) return 0;
  const alnum = s.toLowerCase().match(/[a-z0-9]+/g);
  if (alnum && alnum.length) return alnum.length;
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function targetCap(targetTokens?: number): number {
  const n = Number(targetTokens);
  return Number.isFinite(n) && n > 0 ? n : CHUNK_TARGET_TOKENS;
}

function wrapAtTokenCount(text: string, target: number): string[] {
  const s = text.trim();
  if (!s) return [];
  if (estimateTokens(s) <= target) return [s];
  const starts: number[] = [];
  const ends: number[] = [];
  const re = /[a-z0-9]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    starts.push(m.index);
    ends.push(m.index + m[0].length);
  }
  if (starts.length <= 1) {
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length <= 1) return [s];
    const out: string[] = [];
    for (let i = 0; i < words.length;) {
      const j = Math.min(i + target, words.length);
      out.push(words.slice(i, j).join(" "));
      i = j;
    }
    return out;
  }
  const out: string[] = [];
  for (let i = 0; i < starts.length;) {
    const j = Math.min(i + target, starts.length);
    const from = i === 0 ? 0 : starts[i]!;
    const to = j === starts.length ? s.length : ends[j - 1]!;
    const piece = s.slice(from, to).trim();
    if (piece) out.push(piece);
    i = j;
  }
  return out.length ? out : [s];
}

/**
 * Sentence-preserving pack. Split on `(?<=[.!?])\s+`, add until
 * estimateTokens(cur) >= target, then flush. A sentence longer than target is
 * hard-wrapped at token boundaries (mid-word only when a unit is one enormous token).
 */
export function chunkText(text: string, targetTokens?: number): string[] {
  const target = targetCap(targetTokens);
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const sentences = raw
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const units: string[] = [];
  for (const s of sentences.length ? sentences : [raw]) {
    if (estimateTokens(s) > target) units.push(...wrapAtTokenCount(s, target));
    else units.push(s);
  }
  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    if (!u) continue;
    cur = cur ? `${cur} ${u}` : u;
    if (estimateTokens(cur) >= target) {
      chunks.push(cur);
      cur = "";
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function reconstruct(chunks: { i: number; text: string }[]): string {
  const rows = Array.isArray(chunks) ? chunks.slice() : [];
  rows.sort((a, b) => (Number(a?.i) || 0) - (Number(b?.i) || 0));
  return rows
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function scrub(text: string): string {
  let s = scrubMemoryText(String(text ?? ""));
  SECRET_INLINE.lastIndex = 0;
  return s.replace(SECRET_INLINE, "[secret]");
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function asChunk(v: unknown): NarrativeChunk | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const text = typeof o.text === "string" ? o.text : "";
  if (!id || !text) return null;
  const i = typeof o.i === "number" && Number.isInteger(o.i) && o.i >= 0 ? o.i : -1;
  if (i < 0) return null;
  const t = typeof o.t === "number" && Number.isFinite(o.t) ? o.t : 0;
  const row: NarrativeChunk = { id, text, i, t };
  if (typeof o.src === "string" && o.src) row.src = o.src;
  return row;
}

function load(path: string): NarrativeChunk[] {
  if (!existsSync(path)) return [];
  const out: NarrativeChunk[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const row = asChunk(JSON.parse(line));
        if (row) out.push(row);
      } catch {
        // Torn or invalid line — skip.
      }
    }
  } catch {}
  return out;
}

function persist(path: string, rows: NarrativeChunk[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileAtomic(path, body);
  try {
    chmodSync(path, 0o600);
  } catch {}
}

function srcKey(c: NarrativeChunk): string {
  return typeof c.src === "string" ? c.src : "";
}

function stableOrder(a: NarrativeChunk, b: NarrativeChunk): number {
  const as = srcKey(a);
  const bs = srcKey(b);
  if (as !== bs) return as < bs ? -1 : 1;
  if (a.i !== b.i) return a.i - b.i;
  return a.t - b.t;
}

function mint(text: string, opts?: { src?: string; t?: number }): NarrativeChunk[] {
  const body = scrub(text).trim();
  if (!body) return [];
  const parts = chunkText(body);
  if (!parts.length) return [];
  const src = typeof opts?.src === "string" ? opts.src.trim() : "";
  const n = Number(opts?.t);
  const t = Number.isFinite(n) ? n : Date.now();
  return parts.map((p, i) => {
    const row: NarrativeChunk = { id: newId(), text: p, i, t };
    if (src) row.src = src;
    return row;
  });
}

export class ChunkStore {
  readonly dir: string;
  readonly path: string;
  private readonly lockPath: string;

  constructor(dir: string) {
    this.dir = dir;
    this.path = join(dir, FILE);
    this.lockPath = `${this.path}.lock`;
    try {
      mkdirSync(dir, { recursive: true });
      try {
        chmodSync(dir, 0o700);
      } catch {}
    } catch {}
  }

  /** Split `text` into ~512-token sentence-preserving chunks and persist. Fail-open: never throw. */
  put(text: string, opts?: { src?: string; t?: number }): NarrativeChunk[] {
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

  /** All chunks, stable order (src then i). Fail-open: [] */
  all(): NarrativeChunk[] {
    try {
      return load(this.path).sort(stableOrder);
    } catch {
      return [];
    }
  }

  /** File / ingest order (observe sequence). Fail-open: [] */
  ingestOrder(): NarrativeChunk[] {
    try {
      return load(this.path);
    } catch {
      return [];
    }
  }

  /** Chunks for one src id */
  forSrc(src: string): NarrativeChunk[] {
    try {
      const key = String(src ?? "").trim();
      if (!key) return [];
      return load(this.path)
        .filter((c) => c.src === key)
        .sort((a, b) => a.i - b.i || a.t - b.t);
    } catch {
      return [];
    }
  }
}
