/**
 * Implication cards from a disk cache (lab only; docs/research/moon-cards.md): each card the model made for a
 * simulated item is kept under the item's content hash (`cardKey`), so funnel and simulation reruns replay them at no
 * cost. The worlds are generated, so nothing here is user data; the engine itself never writes a card to disk (D8).
 *
 * `DiskCardMaker` answers a batch from the cache; an item it holds no card for is uncovered (null), as an item the
 * enrichment never reached would be, unless a live maker is given, whose answers are then appended to the cache, or
 * to `out` when one is given. A run that replays a committed file passes `out`: the replay file is then only ever
 * read, so a run cannot change its own input halfway (the oneturn track's replay file was mutated during a run), and
 * the next run that names both files replays both.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { cardKey, ItemCache, type Card, type CardMaker } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { INTENT_INERT } from "./reader-stub";
import { parseSuites } from "./suites";

/**
 * One line of `cards.jsonl`: an item's hash, its card (null: the model said none) and, when the call that made it
 * also asked for them, the requests it would change (`r`, D87). A line with `r` and no `c` is a live call's requests
 * for an item it gave no card: replayed as requests only, the card still uncovered.
 */
interface Line {
  h: string;
  c?: Card | null;
  r?: string[];
}

/** A replay file's text: gzipped files (the checked-in `distilled/*.jsonl.gz`) are read as they are committed. */
const readText = (file: string) =>
  file.endsWith(".gz") ? gunzipSync(readFileSync(file)).toString("utf8") : readFileSync(file, "utf8");

/**
 * The requests of `cards-enrich.ts --intent` (`intent-v<N>.jsonl`, lines `{h, r, c}`): an item's hash → the requests
 * it would change (D87, docs/research/edge-intent.md). Several files merge, the later winning.
 */
export function loadRequests(...files: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readText(file).split("\n")) {
      if (!line.trim()) continue;
      const l = JSON.parse(line) as { h: string; r?: unknown };
      if (Array.isArray(l.r))
        out.set(
          l.h,
          l.r.filter((x): x is string => typeof x === "string"),
        );
    }
  }
  return out;
}

export function loadCards(file: string): Map<string, Card | null> {
  const out = new Map<string, Card | null>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const l = JSON.parse(line) as Line;
    // A requests-only line holds no card: the item stays uncovered for the cards.
    if (l.c !== undefined) out.set(l.h, l.c);
  }
  return out;
}

/**
 * The checked-in intent requests (`cards-enrich.ts --intent` with Haiku; D110, D158, topped up on 2026-11-06) and the
 * suite × seed shards they were made for. The file is keyed on item content, so a run outside these would replay only
 * the items its worlds happen to share: the funnel and the live harnesses leave such a run's intent inert, and say
 * so, rather than half-replaying.
 */
export const INTENT_FILE = "intent-v2.jsonl.gz";
export const INTENT_PATH = join(import.meta.dir, "..", "..", "lab", "distilled", INTENT_FILE);
export const INTENT_COVERS: Record<string, string[]> = {
  ...Object.fromEntries(parseSuites("train").map((s) => [s, ["41", "42", "43", "44"]])),
  heldout10: ["41", "42"],
  heldout11: ["41", "42"],
  heldout13: ["41", "42", "43", "44"],
  // RealUse-1 (docs/research/realuse-1/A-heldout14.md): topped up on Haiku 5.5, 2026-11-06.
  heldout14: ["41", "42", "43", "44"],
  // The weak-points plan's blind suite (docs/research/fix-s3b-lab.md): made on Haiku 5.5 on 2026-11-07, unrun.
  heldout15: ["41", "42", "43", "44"],
};

/** The suite × seed shards INTENT_FILE was not made for. */
export function intentUncovered(suites: string[], seeds: (string | number)[]): string[] {
  return suites.flatMap((s) =>
    seeds.filter((seed) => !INTENT_COVERS[s]?.includes(String(Number(seed)))).map((seed) => `${s} seed ${seed}`),
  );
}

/**
 * `--intent` for the live harnesses (pi-ab, hermes-ab), as the funnel resolves it (D158): `default` replays
 * INTENT_PATH when the configuration has intent, the cards are replayed (`--cards`) and the file covers every suite
 * and seed of the run; `none` replays nothing; anything else is a comma list of files. `note` says which and why.
 */
export function harnessIntent(
  arg: string,
  run: { wanted: boolean; cardsReplayed: boolean; suites: string[]; seeds: (string | number)[] },
): { files: string[]; note: string } {
  if (arg === "none") return { files: [], note: "--intent none" };
  if (arg !== "default") return { files: arg.split(",").filter(Boolean), note: arg };
  if (!run.wanted || !run.cardsReplayed) return { files: [], note: "" };
  const uncovered = intentUncovered(run.suites, run.seeds);
  if (!uncovered.length) return { files: [INTENT_PATH], note: `${INTENT_FILE} by default, D158` };
  const shown = uncovered.slice(0, 4).join(", ") + (uncovered.length > 4 ? `, … ${uncovered.length - 4} more` : "");
  return { files: [], note: `the checked-in requests do not cover ${shown}` };
}

/**
 * How many of the items a run's sources hold (each source's `listAll`, redacted as the cache redacts them, as
 * cards-enrich.ts reads them) have replayed requests: `found` of `of` distinct items.
 */
export function intentCoverage(
  sourceItems: ContextItem[][],
  requests: Map<string, string[]>,
): { found: number; of: number } {
  const keys = new Set<string>();
  for (const raw of sourceItems) {
    const cache = new ItemCache({ maxItemsPerUser: 100_000 });
    for (const it of cache.put({ tenantId: "t", userId: "u" }, raw, 0)) keys.add(cardKey(it));
  }
  let found = 0;
  for (const h of keys) if (requests.get(h)?.length) found++;
  return { found, of: keys.size };
}

/**
 * The harness header's intent line. With cards made live the card model writes each carded item's requests; with
 * cards replayed only a replayed requests file gives the rest theirs, so a run with none covering it is labelled
 * INTENT_INERT (what it measures is the default with intent inert for the items no live call carded).
 */
export function intentLine(o: {
  wanted: boolean;
  cardsReplayed: boolean;
  files: string[];
  note: string;
  found: number;
  of: number;
}): string {
  if (!o.wanted) return "intent: off";
  if (!o.cardsReplayed) return "intent: live (the card model writes the requests of the items it cards)";
  // Inert is what the replay holds, not which files were named: a named file that matches nothing is inert too, and
  // requests replayed from the card files alone (no requests file) are a partial replay, said so.
  const label =
    o.found === 0 ? `  ${INTENT_INERT}` : o.files.length === 0 ? "  [intent partial: from the card files only]" : "";
  return `intent: replayed ${o.found} of ${o.of} items (${o.note || "no --intent"})${label}`;
}

/**
 * Whether two paths name one file: resolved against the working directory and through symlinks, through the file's
 * directory when the file does not exist yet (an output file). A raw string comparison lets `./a.jsonl` past a check
 * that it is not `a.jsonl`.
 */
export function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    const abs = resolve(p);
    if (existsSync(abs)) return realpathSync(abs);
    const dir = dirname(abs);
    return dir === abs ? abs : resolve(real(dir), basename(abs));
  };
  return real(a) === real(b);
}

const NONE: Card = { kind: "none", actions: [], entities: [], statement: "" };

/** Cards a live call is making now, by hash (undefined when the call failed or the model gave none back). */
type Inflight = Map<string, Promise<Card | undefined>>;

export class DiskCardMaker implements CardMaker {
  readonly cards: Map<string, Card | null>;
  /**
   * Shared like `cards`, so streams that miss the same item at once (pi-ab's `eden` and `eden~ALL2` on one world)
   * pay for its card once and get the same card, not two different ones that would confound the paired A/B.
   */
  readonly inflight: Inflight;
  hits = 0;
  misses = 0;

  private readonly out: string;
  /**
   * Replayed requests (`intent`, D87), by hash: a call that asks for them (`make`'s `intent`) gets each item's from
   * here (null when none was made). A live miss's requests are kept here too and appended with its card to `out`
   * (`{h, c, r}`), so a later run that replays `out` replays them.
   */
  readonly requests: Map<string, string[]>;

  /**
   * `options.out`: where new cards go (its cards and requests are replayed too); default the cache file itself.
   * `options.shared`: another maker of the same files, whose cards and calls in flight this one shares, so several
   * makers read the files once and see each other's new cards (pi-ab's streams), and its replayed requests.
   * `options.requests`: requests files (`loadRequests`, `.gz` read as is) replayed when a call asks for requests; they
   * win over requests in the card files (`r` lines a live call wrote). `options.cardRequests: false` skips those `r`
   * lines, so a run that opts out of replayed intent (`--intent none`, or a run the checked-in file does not cover)
   * replays none, whatever an earlier run left in `--cards-out` (a live call's requests still count). An item with
   * requests but no replayed card is given a none card, so the cards a run matches are exactly the card files' (the
   * requests' files may hold cards of their own, from another model: they are not read here).
   */
  constructor(
    file: string,
    private readonly live?: CardMaker,
    options: {
      out?: string;
      shared?: { cards: Map<string, Card | null>; inflight: Inflight; requests?: Map<string, string[]> };
      requests?: string[];
      cardRequests?: boolean;
    } = {},
  ) {
    this.out = options.out ?? file;
    this.cards = options.shared?.cards ?? loadCards(file);
    this.inflight = options.shared?.inflight ?? new Map();
    const cardFiles = options.out && !samePath(options.out, file) ? [file, options.out] : [file];
    const replayed = options.cardRequests === false ? [] : cardFiles;
    this.requests = options.shared?.requests ?? loadRequests(...replayed, ...(options.requests ?? []));
    if (!options.shared && options.out) for (const [h, c] of loadCards(options.out)) this.cards.set(h, c);
  }

  async make(
    items: ContextItem[],
    today: string,
    signal: AbortSignal,
    retry = false,
    intent: boolean | number = false,
  ) {
    const got = await this.makeCards(items, today, signal, retry, intent);
    if (!intent) return got;
    const requests = items.map((it) => this.requests.get(cardKey(it)) ?? null);
    // Requests with no card: the item is covered, with no constraint (as a card file's uncovered item matches none).
    const cards = got.cards.map((c, i) => c ?? (requests[i] ? NONE : null));
    return { ...got, cards, requests };
  }

  private async makeCards(
    items: ContextItem[],
    today: string,
    signal: AbortSignal,
    retry: boolean,
    intent: boolean | number,
  ) {
    const out: (Card | null)[] = [];
    const missing: number[] = [];
    // Items whose card a call (this one's, or another stream's) is making: filled in when it settles.
    const waiting: [number, Promise<Card | undefined>][] = [];
    const settle = new Map<string, (c: Card | undefined) => void>();
    items.forEach((it, i) => {
      const h = cardKey(it);
      out[i] = null;
      const pending = this.inflight.get(h);
      if (this.cards.has(h)) {
        // A retry (the live call was cut off) re-reads the same batch: counted once.
        if (!retry) this.hits++;
        // A card the model said was none replays as a none card: covered, nothing to match.
        out[i] = this.cards.get(h) ?? { kind: "none", actions: [], entities: [], statement: "" };
      } else if (pending) {
        if (!retry) this.hits++;
        waiting.push([i, pending]);
      } else {
        if (!retry) this.misses++;
        if (!this.live) return;
        missing.push(i);
        const p = new Promise<Card | undefined>((done) => settle.set(h, done));
        this.inflight.set(h, p);
        waiting.push([i, p]);
      }
    });
    let costUsd = 0;
    let truncated = false;
    if (this.live && missing.length > 0) {
      const made = new Map<string, Card>();
      try {
        const got = await this.live.make(
          missing.map((i) => items[i]!),
          today,
          signal,
          retry,
          intent,
        );
        costUsd = got.costUsd;
        truncated = got.truncated === true;
        missing.forEach((i, k) => {
          const h = cardKey(items[i]!);
          const r = got.requests?.[k] ?? undefined;
          if (r) this.requests.set(h, r);
          const c = got.cards[k];
          if (c === undefined || c === null) {
            // Requests with no card: kept for the next run, the card left uncovered (asked again then).
            if (r) this.append({ h, r });
            return;
          }
          made.set(h, c);
          this.put(h, c.kind === "none" ? null : c, r);
        });
      } finally {
        // Settled whether or not the call worked: a card it did not make is uncovered for every waiter, and the next
        // call that misses it asks again (a cut-off call's own stream sends it again as `retry`).
        for (const [h, done] of settle) {
          this.inflight.delete(h);
          done(made.get(h));
        }
      }
    }
    for (const [i, p] of waiting) out[i] = (await p) ?? null;
    return { cards: out, costUsd, truncated };
  }

  /** Keeps a card (and, when the call asked for them, the item's requests) and appends it to `out`. */
  put(h: string, c: Card | null, r?: string[]): void {
    this.cards.set(h, c);
    this.append(r ? { h, c, r } : { h, c });
  }

  private append(line: Line): void {
    appendFileSync(this.out, `${JSON.stringify(line)}\n`);
  }
}
