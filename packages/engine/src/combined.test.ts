import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { CardEnricher, type Card, type CardMaker } from "./cards";
import { ContextPartner } from "./partner";

/**
 * The edge tracks together (docs/research/edge-combined.md): `askGuard`'s "nothing found" line is a claim about the
 * whole answer, so an item a model-made path chose for the request (`intent`, the bridging queries), which the rule
 * paths' verdicts never read as a block, withholds it.
 */
const T0 = Date.UTC(2026, 9, 27, 9);
const HOUR = 3_600_000;

class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  readonly items: ContextItem[];
  constructor(
    readonly id: string,
    docs: { ref: string; title: string; text: string }[],
  ) {
    this.items = docs.map((d, i) => ({
      id: itemId(id, d.ref),
      sourceId: id,
      ref: d.ref,
      title: d.title,
      text: d.text,
      updatedAt: T0 - (i + 1) * HOUR,
    }));
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text.toLowerCase().split(/\W+/).filter(Boolean);
    return this.items.filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
  }
}

const NONE: Card = { kind: "none", actions: [], entities: [], statement: "" };

/** Cards are none; requests come from a table by item title. */
class Requests implements CardMaker {
  constructor(private readonly table: Record<string, string[]>) {}
  async make(items: ContextItem[], _today: string, _signal: AbortSignal, _retry?: boolean, intent?: boolean) {
    return {
      cards: items.map(() => NONE),
      ...(intent ? { requests: items.map((i) => this.table[i.title] ?? []) } : {}),
      costUsd: 0,
    };
  }
}

const LUNCH = { ref: "l1", title: "Lunch with Priya", text: "Priya Shah likes the Italian place on Hill Street." };
// Shares no content word with the question; the rule paths read no block in it.
const SAVER = {
  ref: "s1",
  title: "Your Fixed Rate Saver",
  text: "Your 1 Year Fixed Rate Saver (ending 4471) matures in December. Withdrawals aren't possible before maturity.",
};
const MOVE = "Move £3,000 from my savings into the current account tomorrow.";

async function setup(config: Record<string, unknown>) {
  let clock = T0;
  const mail = new ListSource("mail", [LUNCH, SAVER]);
  const cards = new CardEnricher({
    maker: new Requests({ [SAVER.title]: ["move money out of my savings account", "withdraw from savings"] }),
    budget: new Budget(),
    now: () => clock,
  });
  const partner = new ContextPartner({
    sources: async () => [mail],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    cards,
    config: { syncPageSize: 10, syncCallsPerMin: 600, askVerdicts: true, sync: true, cards: true, ...config },
  });
  const scope = { tenantId: "t1", userId: "u1" };
  partner.sync!.track(scope);
  for (let i = 0; i < 10 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
  await cards.idle();
  clock += HOUR;
  return { ask: () => partner.ask({ ...scope, sessionId: "s1", question: MOVE }) };
}

describe("askGuard with the intent index", () => {
  test("an item only the intent index chose withholds the 'nothing found' line; without intent it is said", async () => {
    const guardOnly = await (await setup({ askGuard: true })).ask();
    expect(guardOnly.citations.map((c) => c.itemId)).not.toContain(itemId("mail", "s1"));
    expect(guardOnly.answer).toContain("Checked mail: no rule, hold, limit, absence or change found");

    const both = await (await setup({ askGuard: true, intent: true })).ask();
    expect(both.citations.map((c) => c.itemId)).toContain(itemId("mail", "s1"));
    expect(both.answer).toContain("Withdrawals aren't possible before maturity");
    expect(both.answer).not.toContain("Checked ");
  });
});
