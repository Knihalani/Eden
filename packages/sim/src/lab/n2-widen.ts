/**
 * N2 (D511): the lab's `widen` dependency for the `pushWiden` trial, read from a precomputed embedding table
 * (`packages/sim/modal/n2_embed.py`: per world and request, the item ids an open embedding model ranks first). Lab
 * only; no product package wires a `widen`. The table is made offline on simulated worlds, so the push makes no call.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/** (suite|seed|variant) → request text → ids, best first. */
export type WidenTable = Map<string, Map<string, string[]>>;

export function loadWidenTable(path: string): WidenTable {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  const out: WidenTable = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { suite: string; seed: number; variant: string; request: string; top: string[] };
    const k = `${r.suite}|${r.seed}|${r.variant}`;
    let m = out.get(k);
    if (!m) out.set(k, (m = new Map()));
    m.set(norm(r.request), r.top);
  }
  return out;
}

/** Requests reach the engine redacted (`sanitizeForStore`) and may differ in spacing: matched on letters and digits. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function widenFor(table: WidenTable, suite: string, seed: number, variant: string) {
  const m = table.get(`${suite}|${seed}|${variant}`);
  return async (_scope: unknown, request: string, k: number): Promise<readonly string[]> =>
    (m?.get(norm(request)) ?? []).slice(0, k);
}

/**
 * N5 (D530): the same table keyed by item content, so it serves any world built from the same items (a `--days`
 * user's world holds the short worlds' items under other ids). Per (seed, request) and variant: content hashes (the
 * head of an item's card key), best first (`packages/sim/lab/n5/`; a variant's list equal to the hidden one is not
 * stored twice).
 */
type Variant = "hidden" | "control" | "neutral";
export type WidenHashTable = Map<number, Map<string, Partial<Record<Variant, string[]>>>>;

export function loadWidenHashTable(path: string): WidenHashTable {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  const out: WidenHashTable = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as {
      seed: number;
      request: string;
      top: string[];
      control?: string[];
      neutral?: string[];
    };
    let m = out.get(r.seed);
    if (!m) out.set(r.seed, (m = new Map()));
    m.set(norm(r.request), { hidden: r.top, control: r.control ?? r.top, neutral: r.neutral ?? r.top });
  }
  return out;
}

/** What a run found of its requests in the table, for its own line (a request not in it widens nothing). */
export interface WidenUse {
  asked: number;
  found: number;
  /** Hashes looked up, and those the world holds. */
  hashes: number;
  held: number;
}

/**
 * The `widen` dependency over a content-keyed table: `idOf` gives the world's item id for a content hash (the head
 * of `cardKey` of the item as the cache holds it), or undefined when the world does not hold it; `variantOf` says
 * which variant's world the request was planted in (its list is the one read).
 */
export function widenByHash(
  table: WidenHashTable,
  seed: number,
  idOf: (hash: string) => string | undefined,
  variantOf: (request: string) => string | undefined,
  use?: WidenUse,
) {
  const m = table.get(seed);
  return async (_scope: unknown, request: string, k: number): Promise<readonly string[]> => {
    const lists = m?.get(norm(request));
    const top = lists?.[(variantOf(norm(request)) ?? "hidden") as Variant] ?? lists?.hidden;
    if (use) {
      use.asked++;
      if (top) use.found++;
    }
    const out: string[] = [];
    for (const h of top ?? []) {
      if (out.length >= k) break;
      const id = idOf(h);
      if (use) {
        use.hashes++;
        if (id) use.held++;
      }
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  };
}

/** A request as the tables key it (letters and digits), for a caller's own request → variant map. */
export const widenKey = norm;
