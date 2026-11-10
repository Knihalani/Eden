#!/usr/bin/env bun
/**
 * The card model's distillation set and its scorer (M0, lab only; `packages/sim/modal/cards_distill.py` trains and
 * serves on it). Nothing in a product package imports this file.
 *
 *   bun packages/sim/src/lab/cards-distill.ts export --out DIR [--suite train] [--seeds 41,42,43,44]
 *     [--cards-from intent|replay] [--cards default|F[,F]] [--intent default|none|F] [--batch-sizes 20,10,5]
 *     [--holdout 0.1] [--seed 7] [--train-batchings 1]
 *   bun packages/sim/src/lab/cards-distill.ts score --data DIR/heldout.jsonl --outputs OUT.jsonl [--json F]
 *
 * `export`: every item a sync of the train worlds would read (as `cards-enrich.ts` builds them: each suite's hidden,
 * control and neutral worlds, planted items dressed, sources' `listAll`, redacted by the cache), batched into the
 * exact messages Eden's card call sends (`cardMessages`, with the intent instructions when `--intent` is not `none`,
 * as the shipped default asks). The target is a cached card joined by `cardKey`, and with intent the item's replayed
 * requests (`--intent`, default the checked-in `intent-v2.jsonl.gz`). Where the card comes from:
 *
 * - `--cards-from intent` (the default): the card Haiku 5.5 wrote in the same call as the requests (the `c` of each
 *   `intent-v2` line, `cards-enrich.ts --intent`): one teacher, one prompt, the one the default sends.
 * - `--cards-from replay`: the card the funnel replays (`--cards`; `default` is funnel.ts's merge of
 *   `packages/sim/lab/cards/`). Those files mix teachers (`cards-train.jsonl` was made on glm-5.3-flash, docs/LAB.md)
 *   and prompts without the intent instructions; on the train worlds they agree with Haiku's flag on 645 of 878
 *   items both cover (2026-11-10).
 *
 * Either way an item the prefilter rejects is read for its requests only, so its card is none, as the enricher keeps
 * it. Items with no cached card (or, with intent, no requests) are left out: there is no target to learn.
 *
 * Only train suites are accepted, and any item planted in a held-out (or dev) suite's world is dropped from both
 * splits even when a train world happens to hold the same text: the held-out measurements stay blind to the
 * distilled model. 10% of items (`--holdout`, by a hash of the card key, so stable across runs) are held out; the
 * splits are batched separately, so no held-out item is ever in a training prompt.
 *
 * Rows (`train.jsonl`, `heldout.jsonl`): `{id, keys, messages: [system, user, assistant], maxTokens}`, the
 * assistant turn being the target JSON. `manifest.json` records what made them.
 *
 * `score`: reads each held-out row's model output (`{id, text}` lines) with Eden's own parsers (`parseCards`,
 * `parseRequests`: the fields as the engine keeps them, bounded and validated) and compares with the target read
 * the same way: the parse rate, the constraint flag (kind not none), kind, actions, span,
 * limit, entities, and the requests' coverage. `kept` (M2) is the flag on items the shipped default keeps a card for
 * (`carded`: the strict prefilter passes them); a flag on any other item is dropped by the enricher.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  CARD_VERSION,
  cardKey,
  cardMessages,
  INTENT_VERSION,
  ItemCache,
  parseCards,
  parseRequests,
  worthCarding,
  worthCardingStrict,
  type Card,
} from "@eden/engine";
import type { ChatMessage } from "@eden/llm";
import type { ContextItem } from "@eden/protocol";
import { Rng } from "../rng";
import { REALISTIC, simSources } from "../sources";
import { buildWorld } from "../world";
import { INTENT_PATH, loadCards, loadRequests } from "./cards-disk";
import { clearSlot, dress } from "./hidden-context";
import { variantsFor } from "./neutral";
import { parseSuites, SUITES } from "./suites";

/** The day `cards-enrich.ts` made every checked-in card and request with: the prompt's "Today is", so its hash. */
export const DISTILL_TODAY = "2026-10-27";
/** The funnel's default card replay (funnel.ts merges these in this order, the later line winning). */
export const DEFAULT_CARD_FILES = ["cards-v2.jsonl", "cards-train.jsonl"].map((f) =>
  join(import.meta.dir, "..", "..", "lab", "cards", f),
);
const TRAIN = new Set(parseSuites("train"));

/** The cards in requests files (`{h, r, c}` lines; `.gz` read as is): `c` null is none, a line without `c` skipped. */
export function loadIntentCards(...files: string[]): Map<string, Card | null> {
  const out = new Map<string, Card | null>();
  for (const file of files) {
    const text = file.endsWith(".gz") ? gunzipSync(readFileSync(file)).toString("utf8") : readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const l = JSON.parse(line) as { h: string; c?: Card | null };
      if (l.c !== undefined) out.set(l.h, l.c);
    }
  }
  return out;
}

/** Items a sync of these suites' worlds would read, by card key, and the keys of the items each world planted. */
export function syncItems(
  suites: string[],
  seeds: number[],
): { items: Map<string, ContextItem>; planted: Set<string> } {
  const items = new Map<string, ContextItem>();
  const planted = new Set<string>();
  for (const suite of suites) {
    for (const variant of variantsFor(suite, ["hidden", "control", "neutral"] as const)) {
      for (const seed of seeds) {
        // As hidden-funnel.ts and cards-enrich.ts build each world.
        const world = buildWorld({ seed: seed * 1_000 });
        const before = world.items.length;
        const tasks = SUITES[suite]!(world, seed, variant);
        const plantedItems = world.items.slice(before);
        for (const it of plantedItems) dress(world, it);
        const keep = new Set(plantedItems.map((it) => it.id));
        for (const task of tasks) clearSlot(world, task.text, keep);
        const cache = new ItemCache({ maxItemsPerUser: 100_000 });
        const raw = simSources(world, REALISTIC, 0, seed).flatMap((s) => s.listAll());
        for (const it of cache.put({ tenantId: "t", userId: "u" }, raw, 0)) {
          const h = cardKey(it);
          items.set(h, it);
          if (keep.has(it.id)) planted.add(h);
        }
      }
    }
  }
  return { items, planted };
}

/** Whether an item is in the held-out split: a stable hash of its card key under `frac`. */
export function heldOut(h: string, frac: number): boolean {
  const v = parseInt(createHash("sha256").update(`split:${h}`).digest("hex").slice(0, 8), 16);
  return v / 0x1_0000_0000 < frac;
}

/** A card as the model is asked to write it (the prompt's example's key order); none is left out of the reply. */
function cardJson(i: number, c: Card): Record<string, unknown> {
  return {
    i,
    kind: c.kind,
    actions: c.actions,
    entities: c.entities,
    ...(c.start ? { start: c.start } : {}),
    ...(c.end ? { end: c.end } : {}),
    ...(c.limit !== undefined ? { limit: c.limit, unit: c.unit ?? "" } : {}),
    statement: c.statement,
  };
}

/** The reply the model should give for a batch: its cards (none left out) and, with intent, every item's requests. */
export function targetText(cards: (Card | null)[], requests: string[][] | null): string {
  const out: Record<string, unknown> = {
    cards: cards.flatMap((c, i) => (c && c.kind !== "none" ? [cardJson(i, c)] : [])),
  };
  if (requests) out.requests = requests.map((q, i) => ({ i, q }));
  return JSON.stringify(out);
}

/** Output cap for a batch, as `ModelCardMaker` sets it. */
export function maxTokensFor(n: number, intent: boolean): number {
  return intent ? Math.max(3_000, 300 * n) : Math.max(2_000, 200 * n);
}

export interface DistillRow {
  id: string;
  keys: string[];
  messages: ChatMessage[];
  maxTokens: number;
  /**
   * Per item, whether the shipped default keeps the card it is given (M2): the strict prefilter `cardsEconomy` runs
   * (`worthCardingStrict`). An item it rejects is read for its requests only and the enricher drops whatever card
   * the model wrote (`NONE_CARD`), so a flag there costs nothing. Rows exported before M2 lack it (all kept).
   */
  carded?: boolean[];
}

export interface ExportOptions {
  intent: boolean;
  batchSizes: number[];
  holdout: number;
  seed: number;
  today?: string;
  /** Train batchings (M2): the train items cut into batches this many times, each from a new shuffle (default 1). */
  trainBatchings?: number;
}

export interface ExportResult {
  train: DistillRow[];
  heldout: DistillRow[];
  stats: Record<string, number>;
}

/**
 * The rows: each item with a target (a replayed card, or the prefilter's none for an item read for requests only;
 * with intent, replayed requests) goes to one split by `heldOut`, and each split is shuffled and cut into batches
 * cycling through `batchSizes`. `exclude`: keys never used (held-out worlds' planted items).
 */
export function buildRows(
  items: Map<string, ContextItem>,
  cards: Map<string, Card | null>,
  requests: Map<string, string[]>,
  exclude: Set<string>,
  o: ExportOptions,
): ExportResult {
  const today = o.today ?? DISTILL_TODAY;
  const stats = { items: items.size, excluded: 0, noCard: 0, noRequests: 0, kept: 0, constraint: 0 };
  const split: Record<"train" | "heldout", [string, ContextItem, Card | null, string[] | null][]> = {
    train: [],
    heldout: [],
  };
  // Sorted keys: the output does not depend on the order the worlds were built in.
  for (const h of [...items.keys()].sort()) {
    const it = items.get(h)!;
    if (exclude.has(h)) {
      stats.excluded++;
      continue;
    }
    const q = o.intent ? requests.get(h) : undefined;
    if (o.intent && q === undefined) {
      stats.noRequests++;
      continue;
    }
    // As the enricher keeps it: an item the prefilter rejects is read for its requests only, its card none.
    const passes = worthCarding(it);
    let card: Card | null;
    if (!passes && o.intent) card = null;
    else if (cards.has(h)) card = cards.get(h) ?? null;
    else {
      stats.noCard++;
      continue;
    }
    stats.kept++;
    if (card && card.kind !== "none") stats.constraint++;
    split[heldOut(h, o.holdout) ? "heldout" : "train"].push([h, it, card, q ?? null]);
  }
  const rng = new Rng(o.seed);
  const batch = (name: "train" | "heldout", rows: DistillRow[] = []): DistillRow[] => {
    const list = rng.sample(split[name], split[name].length);
    for (let at = 0, k = 0; at < list.length; k++) {
      const size = o.batchSizes[k % o.batchSizes.length]!;
      const part = list.slice(at, at + size);
      at += size;
      const messages = cardMessages(
        part.map(([, it]) => it),
        today,
        o.intent,
      );
      const target = targetText(
        part.map(([, , c]) => c),
        o.intent ? part.map(([, , , q]) => q ?? []) : null,
      );
      rows.push({
        id: `${name}-${rows.length}`,
        keys: part.map(([h]) => h),
        messages: [...messages, { role: "assistant", content: target }],
        maxTokens: maxTokensFor(part.length, o.intent),
        carded: part.map(([, it]) => worthCardingStrict(it)),
      });
    }
    return rows;
  };
  // The first batching and the held-out rows draw from the rng as a one-batching export does, so they are the same
  // rows; later batchings re-cut the same train items (and the same targets) into new batches after them.
  const train = batch("train");
  const heldout = batch("heldout");
  for (let n = 1; n < (o.trainBatchings ?? 1); n++) batch("train", train);
  return { train, heldout, stats };
}

/** Every suite that is not a train suite, whose planted items are kept out of the set. */
export function guardedSuites(): string[] {
  return Object.keys(SUITES).filter((s) => !TRAIN.has(s));
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring.

/** One item's agreement: its target and output each read by `parseCards` (and `parseRequests` with intent). */
export interface ItemScore {
  parsed: boolean;
  flagRef: boolean;
  flagOut: boolean;
  kind: boolean;
  actions: boolean;
  span: boolean;
  limit: boolean;
  entities: number;
  requests: number | null;
  /** Whether the shipped default keeps this item's card (`DistillRow.carded`); true when the row does not say. */
  carded: boolean;
}

const set = (a: string[]) => [...new Set(a)].sort().join("|");
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9£$€%]+/g) ?? []);

/** Jaccard of two string lists' words (1 when both empty). */
export function overlap(a: string[], b: string[]): number {
  const x = words(a.join(" "));
  const y = words(b.join(" "));
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** One batch: the target and the model's output read by Eden's parsers, item by item. */
export function scoreBatch(
  target: string,
  output: string,
  count: number,
  intent: boolean,
  carded?: boolean[],
): ItemScore[] {
  const ref = parseCards(target, count);
  const got = parseCards(output, count);
  const refQ = intent ? parseRequests(target, count) : null;
  const gotQ = intent ? parseRequests(output, count) : null;
  return ref.map((r, i) => {
    const g = got[i] ?? null;
    const rr = r ?? { kind: "none", actions: [], entities: [], statement: "" };
    const gg = g ?? { kind: "none", actions: [], entities: [], statement: "" };
    const flagRef = rr.kind !== "none";
    const flagOut = gg.kind !== "none";
    const qa = refQ?.[i] ?? [];
    const qb = gotQ?.[i] ?? null;
    return {
      parsed: g !== null,
      flagRef,
      flagOut,
      kind: rr.kind === gg.kind,
      actions: set(rr.actions) === set(gg.actions),
      span: (rr.start ?? "") === (gg.start ?? "") && (rr.end ?? "") === (gg.end ?? ""),
      limit: (rr.limit ?? null) === (gg.limit ?? null),
      entities: overlap(rr.entities, gg.entities),
      requests: intent ? (qb === null ? null : overlap(qa, qb)) : null,
      carded: carded?.[i] ?? true,
    };
  });
}

const rate = (n: number, d: number) => (d ? Number((n / d).toFixed(4)) : null);

/** The summary over every held-out item: rates on all items, and field agreement where both say a constraint. */
export function summarize(scores: ItemScore[], batches: { parsed: number; of: number }) {
  const both = scores.filter((s) => s.flagRef && s.flagOut);
  const tp = both.length;
  const fp = scores.filter((s) => !s.flagRef && s.flagOut).length;
  const fn = scores.filter((s) => s.flagRef && !s.flagOut).length;
  const req = scores.filter((s) => s.requests !== null);
  // The flag as the shipped default keeps it: only on items whose card it keeps (an item the strict prefilter
  // rejects keeps no card, whatever either model wrote).
  const kept = scores.filter((s) => s.carded);
  const ktp = kept.filter((s) => s.flagRef && s.flagOut).length;
  const kfp = kept.filter((s) => !s.flagRef && s.flagOut).length;
  const kfn = kept.filter((s) => s.flagRef && !s.flagOut).length;
  return {
    items: scores.length,
    batches: batches.of,
    batchParseRate: rate(batches.parsed, batches.of),
    itemParseRate: rate(scores.filter((s) => s.parsed).length, scores.length),
    constraintRef: scores.filter((s) => s.flagRef).length,
    constraintOut: scores.filter((s) => s.flagOut).length,
    flagAgreement: rate(scores.filter((s) => s.flagRef === s.flagOut).length, scores.length),
    flagPrecision: rate(tp, tp + fp),
    flagRecall: rate(tp, tp + fn),
    kindAgreement: rate(scores.filter((s) => s.kind).length, scores.length),
    kept: {
      items: kept.length,
      constraintRef: kept.filter((s) => s.flagRef).length,
      constraintOut: kept.filter((s) => s.flagOut).length,
      flagPrecision: rate(ktp, ktp + kfp),
      flagRecall: rate(ktp, ktp + kfn),
    },
    // On items both call a constraint: the fields the request-time match reads.
    onBoth: {
      n: tp,
      kind: rate(both.filter((s) => s.kind).length, tp),
      actions: rate(both.filter((s) => s.actions).length, tp),
      span: rate(both.filter((s) => s.span).length, tp),
      limit: rate(both.filter((s) => s.limit).length, tp),
      entitiesJaccard: rate(
        both.reduce((a, s) => a + s.entities, 0),
        tp,
      ),
    },
    requestsParsed: req.length ? rate(req.filter((s) => s.requests !== null).length, req.length) : null,
    requestsJaccard: req.length
      ? rate(
          req.reduce((a, s) => a + (s.requests ?? 0), 0),
          req.length,
        )
      : null,
  };
}

/** `score`: each held-out row against its output line (a missing output counts as unparsed). */
export function scoreRows(rows: DistillRow[], outputs: Map<string, string>, intent: boolean) {
  const scores: ItemScore[] = [];
  let parsed = 0;
  for (const row of rows) {
    const out = outputs.get(row.id) ?? "";
    const target = row.messages[2]!.content;
    const s = scoreBatch(target, out, row.keys.length, intent, row.carded);
    if (s.every((x) => x.parsed)) parsed++;
    scores.push(...s);
  }
  return summarize(scores, { parsed, of: rows.length });
}

// ---------------------------------------------------------------------------------------------------------------
// CLI.

const readJsonl = <T>(file: string): T[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

function main(argv: string[]): void {
  const cmd = argv[0];
  const opt = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
  };
  if (cmd === "export") {
    const out = opt("out", "");
    if (!out) throw new Error("export needs --out DIR");
    const suites = parseSuites(opt("suite", "train"));
    const outside = suites.filter((s) => !TRAIN.has(s));
    if (outside.length) throw new Error(`only train suites may be distilled on (not ${outside.join(", ")})`);
    const seeds = opt("seeds", "41,42,43,44").split(",").map(Number);
    const cardArg = opt("cards", "default");
    const cardFiles = cardArg === "default" ? DEFAULT_CARD_FILES : cardArg.split(",").filter(Boolean);
    const intentArg = opt("intent", "default");
    const intentFiles = intentArg === "none" ? [] : intentArg === "default" ? [INTENT_PATH] : intentArg.split(",");
    for (const f of [...cardFiles, ...intentFiles]) if (!existsSync(f)) throw new Error(`no such file: ${f}`);
    const from = opt("cards-from", "intent");
    if (from !== "intent" && from !== "replay") throw new Error("--cards-from is intent or replay");
    if (from === "intent" && !intentFiles.length) throw new Error("--cards-from intent needs an --intent file");
    const cards = new Map<string, Card | null>();
    if (from === "intent") for (const [h, c] of loadIntentCards(...intentFiles)) cards.set(h, c);
    else for (const f of cardFiles) for (const [h, c] of loadCards(f)) cards.set(h, c);
    const requests = loadRequests(...intentFiles);
    const t0 = performance.now();
    const { items } = syncItems(suites, seeds);
    // Every other suite's planted items, on the same seeds (a held-out world shares its seed's background).
    const { planted: guarded } = syncItems(guardedSuites(), seeds);
    const res = buildRows(items, cards, requests, guarded, {
      intent: intentFiles.length > 0,
      batchSizes: opt("batch-sizes", "20,10,5").split(",").map(Number),
      holdout: Number(opt("holdout", "0.1")),
      seed: Number(opt("seed", "7")),
      trainBatchings: Number(opt("train-batchings", "1")),
    });
    mkdirSync(out, { recursive: true });
    const lines = (rows: DistillRow[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
    writeFileSync(join(out, "train.jsonl"), lines(res.train));
    writeFileSync(join(out, "heldout.jsonl"), lines(res.heldout));
    const manifest = {
      suites,
      seeds,
      cardsFrom: from,
      ...(from === "replay" ? { cardFiles: cardFiles.map((f) => relative(process.cwd(), f)) } : {}),
      intentFiles: intentFiles.map((f) => relative(process.cwd(), f)),
      intent: intentFiles.length > 0,
      cardVersion: CARD_VERSION,
      intentVersion: INTENT_VERSION,
      today: DISTILL_TODAY,
      holdout: Number(opt("holdout", "0.1")),
      trainBatchings: Number(opt("train-batchings", "1")),
      trainRows: res.train.length,
      heldoutRows: res.heldout.length,
      trainItems: res.train.reduce((a, r) => a + r.keys.length, 0),
      heldoutItems: res.heldout.reduce((a, r) => a + r.keys.length, 0),
      ...res.stats,
      ms: Math.round(performance.now() - t0),
    };
    writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest));
    return;
  }
  if (cmd === "score") {
    const data = opt("data", "");
    const outputs = opt("outputs", "");
    if (!data || !outputs) throw new Error("score needs --data heldout.jsonl --outputs OUT.jsonl");
    const rows = readJsonl<DistillRow>(data);
    const got = new Map(readJsonl<{ id: string; text: string }>(outputs).map((o) => [o.id, o.text]));
    // The rows say whether they asked for requests: the system prompt carries the intent instructions.
    const intent = rows.some((r) => r.messages[0]!.content.includes('"requests"'));
    const summary = {
      data,
      outputs,
      missing: rows.filter((r) => !got.has(r.id)).length,
      ...scoreRows(rows, got, intent),
    };
    const json = opt("json", "");
    if (json) writeFileSync(json, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.error("usage: cards-distill.ts export --out DIR [...] | score --data F --outputs F [--json F]");
  process.exit(2);
}

if (import.meta.main) main(process.argv.slice(2));
