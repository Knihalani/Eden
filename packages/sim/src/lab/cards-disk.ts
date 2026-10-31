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
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { cardKey, type Card, type CardMaker } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";

/** One line of `cards.jsonl`: an item's hash and its card (null: the model said none). */
interface Line {
  h: string;
  c: Card | null;
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

export class DiskCardMaker implements CardMaker {
  readonly cards: Map<string, Card | null>;
  hits = 0;
  misses = 0;

  private readonly out: string;

  /**
   * `options.out`: where new cards go (its cards are replayed too); default the cache file itself.
   * `options.shared`: another maker's map of the same files, so several makers read them once and see each other's
   * new cards (pi-ab's streams).
   */
  constructor(
    file: string,
    private readonly live?: CardMaker,
    options: { out?: string; shared?: Map<string, Card | null> } = {},
  ) {
    this.out = options.out ?? file;
    this.cards = options.shared ?? loadCards(file);
    if (!options.shared && options.out) for (const [h, c] of loadCards(options.out)) this.cards.set(h, c);
  }

  async make(items: ContextItem[], today: string, signal: AbortSignal) {
    const out: (Card | null)[] = [];
    const missing: number[] = [];
    items.forEach((it, i) => {
      const h = cardKey(it);
      if (this.cards.has(h)) {
        this.hits++;
        // A card the model said was none replays as a none card: covered, nothing to match.
        out[i] = this.cards.get(h) ?? { kind: "none", actions: [], entities: [], statement: "" };
      } else {
        this.misses++;
        out[i] = null;
        missing.push(i);
      }
    });
    let costUsd = 0;
    if (this.live && missing.length > 0) {
      const got = await this.live.make(
        missing.map((i) => items[i]!),
        today,
        signal,
      );
      costUsd = got.costUsd;
      missing.forEach((i, k) => {
        const c = got.cards[k];
        if (c === undefined || c === null) return;
        out[i] = c;
        this.put(cardKey(items[i]!), c.kind === "none" ? null : c);
      });
    }
    return { cards: out, costUsd };
  }

  put(h: string, c: Card | null): void {
    this.cards.set(h, c);
    appendFileSync(this.out, `${JSON.stringify({ h, c } satisfies Line)}\n`);
  }
}
