import { itemId, type ContextItem } from "@eden/protocol";
import type { SearchQuery, Source } from "./source";

export interface StaticDoc {
  ref: string;
  title: string;
  text: string;
  url?: string;
  updatedAt?: number;
  /** Source-reported fields kept with the item (a mailbox category, a label). */
  meta?: Record<string, string>;
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? [];

/**
 * A fixed set of documents with plain term-overlap search. For tests, evals, and a tenant's own reference docs
 * (policies, FAQs) that do not need a live connector.
 */
export class StaticSource implements Source {
  readonly kind = "static";
  private readonly items: ContextItem[];

  constructor(
    readonly id: string,
    readonly description: string,
    docs: StaticDoc[],
  ) {
    this.items = docs.map((d) => ({ ...d, id: itemId(id, d.ref), sourceId: id }));
  }

  async search(query: SearchQuery): Promise<ContextItem[]> {
    const terms = new Set([...words(query.text), ...query.entities.flatMap(words)]);
    if (terms.size === 0) return [];
    return this.items
      .map((item) => {
        const hay = new Set(words(`${item.title} ${item.text}`));
        let hits = 0;
        for (const t of terms) if (hay.has(t)) hits++;
        return { item, hits };
      })
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, query.limit)
      .map((x) => x.item);
  }

  async fetch(ref: string): Promise<ContextItem | null> {
    return this.items.find((i) => i.ref === ref) ?? null;
  }
}
