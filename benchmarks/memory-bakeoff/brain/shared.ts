/** Shared LoCoMo helpers for brain-memory POCs. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const K5 = 5;
export const K20 = 20;
export const LOCOMO = process.env.LOCOMO_PATH || "/tmp/eden-mem-bakeoff/locomo10.json";
export const LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

export const STOP = new Set(
  (
    "the of is a an on to and in for this that with from into about these then still has out how what " +
    "why was are you your its our not or no hey hi hello yeah yes ok okay thanks thank"
  ).split(" "),
);

export type Turn = { text: string; speaker: string; session: number; date: string; at: number };
export type Qa = { question: string; answer: string; category: number };
export type Sample = { conversation: Record<string, unknown>; qa: Qa[] };

export type MemSys = {
  id: string;
  ingest(turns: Turn[]): void;
  retrieve(q: string, k?: number): string[];
  stored(): string[];
};

export function toks(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? []).filter(
    (w) => w.length >= 2 && !STOP.has(w),
  );
}

export function goldHit(retrieved: string, answer: string): boolean {
  const a = String(answer || "")
    .toLowerCase()
    .trim();
  const r = retrieved.toLowerCase();
  if (!a) return false;
  if (r.includes(a)) return true;
  if (a.length <= 8) return false;
  const t = toks(a);
  return t.length > 0 && t.every((w) => r.includes(w));
}

export function bm25(query: string, docs: string[], k: number): string[] {
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
  const k1 = 1.5,
    b = 0.75;
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

export function rrfFuse(lists: string[][], k: number, rrfK = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((d, i) => score.set(d, (score.get(d) || 0) + 1 / (rrfK + i + 1)));
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([d]) => d);
}

export function formatTurn(t: Turn): string {
  const date = t.date ? ` [${t.date}]` : "";
  return `${t.speaker}:${date} ${t.text}`.replace(/\s+/g, " ").trim();
}

/** Parse LoCoMo conversation into dated turns (includes session datetime). */
export function locomoTurns(conv: Record<string, unknown>): Turn[] {
  const out: Turn[] = [];
  let at = 0;
  for (let n = 1; n <= 40; n++) {
    const date = String(conv[`session_${n}_date_time`] || "").trim();
    const sess = conv[`session_${n}`];
    if (!Array.isArray(sess)) continue;
    for (const turn of sess as { text?: string; speaker?: string }[]) {
      const text = String(turn?.text || "").trim();
      if (!text) continue;
      out.push({ text, speaker: String(turn?.speaker || "speaker"), session: n, date, at: at++ });
    }
  }
  return out;
}

export async function loadLocomo(): Promise<Sample[]> {
  if (!existsSync(LOCOMO)) {
    mkdirSync(join(LOCOMO, ".."), { recursive: true });
    const res = await fetch(LOCOMO_URL);
    if (!res.ok) throw new Error(`LoCoMo download failed ${res.status}`);
    writeFileSync(LOCOMO, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(readFileSync(LOCOMO, "utf8")) as Sample[];
}

export function properNames(s: string): string[] {
  return s.match(/\b[A-Z][a-z]{2,14}\b/g) ?? [];
}

export function dateTokens(date: string): string[] {
  // "1:56 pm on 8 May, 2023" → may, 2023, 8, …
  return toks(date.replace(/,/g, " "));
}
