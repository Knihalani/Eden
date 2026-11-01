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
import { basename, dirname, resolve } from "node:path";
import { cardKey, type Card, type CardMaker } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";

/** One line of `cards.jsonl`: an item's hash and its card (null: the model said none). */
interface Line {
  h: string;
  c: Card | null;
}

/**
 * The requests of `cards-enrich.ts --intent` (`intent-v<N>.jsonl`, lines `{h, r, c}`): an item's hash → the requests
 * it would change (D86, docs/research/edge-intent.md). Several files merge, the later winning.
 */
export function loadRequests(...files: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
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
    out.set(l.h, l.c);
  }
  return out;
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
   * Replayed requests (`intent`, D86), by hash: a call that asks for them (`make`'s `intent`) gets each item's from
   * here (null when none was made). A live miss's requests are kept here too, in memory only.
   */
  readonly requests: Map<string, string[]>;

  /**
   * `options.out`: where new cards go (its cards are replayed too); default the cache file itself.
   * `options.shared`: another maker of the same files, whose cards and calls in flight this one shares, so several
   * makers read the files once and see each other's new cards (pi-ab's streams).
   * `options.requests`: requests files (`loadRequests`) replayed when a call asks for requests. An item with requests
   * but no replayed card is given a none card, so the cards a run matches are exactly the card files' (the requests'
   * files may hold cards of their own, from another model: they are not read here).
   */
  constructor(
    file: string,
    private readonly live?: CardMaker,
    options: {
      out?: string;
      shared?: { cards: Map<string, Card | null>; inflight: Inflight };
      requests?: string[];
    } = {},
  ) {
    this.out = options.out ?? file;
    this.cards = options.shared?.cards ?? loadCards(file);
    this.inflight = options.shared?.inflight ?? new Map();
    this.requests = loadRequests(...(options.requests ?? []));
    if (!options.shared && options.out) for (const [h, c] of loadCards(options.out)) this.cards.set(h, c);
  }

  async make(items: ContextItem[], today: string, signal: AbortSignal, retry = false, intent = false) {
    const got = await this.makeCards(items, today, signal, retry, intent);
    if (!intent) return got;
    const requests = items.map((it) => this.requests.get(cardKey(it)) ?? null);
    // Requests with no card: the item is covered, with no constraint (as a card file's uncovered item matches none).
    const cards = got.cards.map((c, i) => c ?? (requests[i] ? NONE : null));
    return { ...got, cards, requests };
  }

  private async makeCards(items: ContextItem[], today: string, signal: AbortSignal, retry: boolean, intent: boolean) {
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
          const r = got.requests?.[k];
          if (r) this.requests.set(cardKey(items[i]!), r);
          const c = got.cards[k];
          if (c === undefined || c === null) return;
          const h = cardKey(items[i]!);
          made.set(h, c);
          this.put(h, c.kind === "none" ? null : c);
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

  put(h: string, c: Card | null): void {
    this.cards.set(h, c);
    appendFileSync(this.out, `${JSON.stringify({ h, c } satisfies Line)}\n`);
  }
}
