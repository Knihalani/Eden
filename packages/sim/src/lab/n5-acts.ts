/**
 * N5 (D529, docs/research/n5-widen-check.md): the lab's `acts` dependency for the `pushCheckGate` trial, and the
 * stored requests' own retrieval route (§1's screen). Lab only: nothing in a product package imports this file.
 * The labels come from `n5-label.ts` (Haiku 5.5, once per item content, no request in hand); everything here is a
 * pure function of a label and a request: no model, no network.
 */
import { appendFileSync } from "node:fs";
import type { ContextItem, Scope } from "@eden/protocol";
import { cardKey, type Anchors, type StoredActs } from "@eden/engine";
import type { ActLabel } from "./n5-label";

/** The label's key for a cached item: its card key's head (`actKey` hashes the same title and text). */
export const actKeyOf = (item: ContextItem) => cardKey(item).slice(0, 20);

const STOP = new Set(
  (
    "a an the and or but if of for to in on at by with from as is are was were be been it its this that these those " +
    "my your our their his her me you we they i he she them us do does did can could would should shall " +
    "might must have has had not no so than then there here what which who whom when where why how all any some " +
    "each every please just also about into over up out off new get got make made put set let need want like go " +
    "going today tomorrow week month year day am pm"
  ).split(" "),
);

/** A text's content words: lower case, letters and digits, light stemming, stop words out. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9£$€]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    let w = raw;
    if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
    else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith("es")) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

/** Two forms of one word meet on their first six letters ("childminder", "childminding"). */
const stem = (w: string) => (w.length > 6 ? w.slice(0, 6) : w);
const stems = (text: string) => new Set(words(text).map(stem));

/** What the request and a stored answer share, for the pass rule and the lab's dump. */
export interface ActFeatures {
  act: boolean;
  /** Keys whose every content word the request holds; of them, keys that are names (a capital or a digit). */
  keys: number;
  nameKeys: number;
  /** Distinct request content words found in the answer's keys or stored requests. */
  ov: number;
  /** The same, each word weighted by how rare it is in the user's stored answers (`idf`; 0 with no index). */
  bm: number;
  /** The best share of one stored request's words that the request holds (0–1). */
  qBest: number;
  /** The request's days against `from`/`to`: inside, outside, or not comparable; and the answer's `dated`. */
  day: "in" | "out" | "na";
  dated: boolean;
}

const DAY_MS = 86_400_000;
const dayOf = (s: string) => Date.parse(`${s}T00:00:00Z`);

/** The request's days as YYYY-MM-DD: its time window's, and the dates it writes out (in the window's or this year). */
function requestDays(a: Anchors, year: number): string[] {
  const out = new Set<string>(a.days);
  for (const { day, month } of a.named)
    out.add(`${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  return [...out];
}

export function features(
  label: ActLabel,
  text: string,
  anchors: Anchors,
  year: number,
  idf: (stem: string) => number = () => 0,
): ActFeatures {
  const req = stems(text);
  let keys = 0;
  let nameKeys = 0;
  const all = new Set<string>();
  for (const key of label.keys ?? []) {
    const ws = [...stems(key)];
    for (const w of ws) all.add(w);
    if (ws.length === 0 || !ws.every((w) => req.has(w))) continue;
    keys++;
    if (/[A-Z0-9]/.test(key)) nameKeys++;
  }
  const qs = (label.q ?? []).map((q) => stems(q));
  for (const q of qs) for (const w of q) all.add(w);
  let ov = 0;
  let bm = 0;
  for (const w of req) {
    if (!all.has(w)) continue;
    ov++;
    bm += idf(w);
  }
  let qBest = 0;
  for (const q of qs) {
    if (q.size === 0) continue;
    let hit = 0;
    for (const w of q) if (req.has(w)) hit++;
    qBest = Math.max(qBest, hit / q.size);
  }
  let day: ActFeatures["day"] = "na";
  const days = requestDays(anchors, year);
  if (days.length > 0 && (label.from || label.to)) {
    const from = label.from ? dayOf(label.from) : -Infinity;
    const to = label.to ? dayOf(label.to) : Infinity;
    day = days.some((d) => dayOf(d) >= from - DAY_MS && dayOf(d) <= to + DAY_MS) ? "in" : "out";
  }
  return {
    act: label.act,
    keys,
    nameKeys,
    ov,
    bm: Math.round(bm * 100) / 100,
    qBest: Math.round(qBest * 100) / 100,
    day,
    dated: label.dated === true,
  };
}

/** The pass rule's settings (the gate's mark is fitted on the fit split and frozen; the note's §7). */
export interface ActRule {
  /** "all": every labelled item passes (the lab's dump run). "act": the stored `act` alone. "match": the gate. */
  mode: "all" | "act" | "match";
  /** "match": the weighted overlap plus 6 for each stored key in the request is at least this. */
  minScore?: number;
}

/** The gate's score of one stored answer for a request. */
export const actScore = (f: ActFeatures) => f.bm + 6 * f.keys;

export function passes(f: ActFeatures, rule: ActRule): boolean {
  if (rule.mode === "all") return true;
  if (!f.act) return false;
  if (rule.mode === "act") return true;
  return actScore(f) >= (rule.minScore ?? 0);
}

export interface ActsUse {
  reads: number;
  items: number;
  unlabelled: number;
}

export interface ActsOptions {
  rule: ActRule;
  /** The world's clock (ms), for the year a written date falls in. */
  now: () => number;
  /** How rare a word is among the user's stored answers (`StoredRequestIndex.idf`), for the weighted overlap. */
  idf?: () => (stem: string) => number;
  /** Counted as the dependency is read: items looked up and those with no stored answer. */
  use?: ActsUse;
  /** `--acts-dump`: each call's request and per-item features, sim data only. */
  dump?: { file: string; tag: Record<string, unknown> };
}

/** The `acts` dependency over a label table: null for an item with no label. */
export function actsFor(table: ReadonlyMap<string, ActLabel>, o: ActsOptions): StoredActs {
  return (_scope: Scope, request, items) => {
    const year = new Date(o.now()).getUTCFullYear();
    const rows: unknown[] = [];
    if (o.use) o.use.reads++;
    const out = items.map((item) => {
      const label = table.get(actKeyOf(item));
      if (o.use) {
        o.use.items++;
        if (!label) o.use.unlabelled++;
      }
      if (!label) {
        rows.push({ id: item.id, k: null });
        return null;
      }
      const f = features(label, request.text, request.anchors, year, o.idf?.());
      rows.push({ id: item.id, k: label.k, ...f });
      return passes(f, o.rule);
    });
    if (o.dump) {
      const row = { ...o.dump.tag, request: request.text, entities: request.anchors.entities, items: rows };
      appendFileSync(o.dump.file, `${JSON.stringify(row)}\n`);
    }
    return out;
  };
}

/**
 * The stored requests' retrieval route: a BM25 search of the request over each act item's `keys` and `q` text, for
 * one world's items. It stands in for the intent index holding the stored requests (a product build would put them
 * there); no call, no embedding.
 */
export class StoredRequestIndex {
  private readonly docs: { id: string; tf: Map<string, number>; len: number }[] = [];
  private readonly df = new Map<string, number>();
  private avg = 1;

  constructor(items: readonly ContextItem[], table: ReadonlyMap<string, ActLabel>) {
    let total = 0;
    for (const item of items) {
      const label = table.get(actKeyOf(item));
      if (!label?.act) continue;
      const ws = words([...(label.keys ?? []), ...(label.q ?? [])].join(" ")).map(stem);
      if (ws.length === 0) continue;
      const tf = new Map<string, number>();
      for (const w of ws) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      this.docs.push({ id: item.id, tf, len: ws.length });
      total += ws.length;
    }
    this.avg = total / Math.max(1, this.docs.length);
  }

  /** A word's rarity among the stored answers (BM25's idf); 0 for a word none holds. */
  idf = (w: string): number => {
    const df = this.df.get(w);
    return df ? Math.log(1 + (this.docs.length - df + 0.5) / (df + 0.5)) : 0;
  };

  /** The best `k` item ids for the request, best first; an item matching fewer than `minMatched` words is left out. */
  search(request: string, k: number, minMatched = 2): { id: string; score: number; matched: number }[] {
    const q = [...stems(request)];
    const n = this.docs.length;
    const hits: { id: string; score: number; matched: number }[] = [];
    for (const d of this.docs) {
      let score = 0;
      let matched = 0;
      for (const w of q) {
        const tf = d.tf.get(w);
        if (!tf) continue;
        matched++;
        const idf = Math.log(1 + (n - this.df.get(w)! + 0.5) / (this.df.get(w)! + 0.5));
        score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.len) / this.avg));
      }
      if (matched >= minMatched) hits.push({ id: d.id, score, matched });
    }
    return hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, k);
  }
}
