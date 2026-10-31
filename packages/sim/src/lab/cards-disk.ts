/**
 * Implication cards from a disk cache (lab only; docs/research/moon-cards.md): each card the model made for a
 * simulated item is kept under the item's content hash (`cardKey`), so funnel and simulation reruns replay them at no
 * cost. The worlds are generated, so nothing here is user data; the engine itself never writes a card to disk (D8).
 *
 * `DiskCardMaker` answers a batch from the cache; an item it holds no card for is uncovered (null), as an item the
 * enrichment never reached would be, unless a live maker is given, whose answers are then appended to the cache.
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

  constructor(
    private readonly file: string,
    private readonly live?: CardMaker,
  ) {
    this.cards = loadCards(file);
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
    appendFileSync(this.file, `${JSON.stringify({ h, c } satisfies Line)}\n`);
  }
}
