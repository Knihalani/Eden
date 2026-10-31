/**
 * Regressions from the review of the background economy (D66): push sync's watch start, notices during the backfill,
 * the notice contract (`SourceChange`), and sentence reuse's key, retention and over-budget count.
 */
import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache, sanitizedId } from "./cache";
import { CardEnricher, sentenceKey, type Card, type CardMaker } from "./cards";
import { ContextPartner } from "./partner";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 9);
const scope: Scope = { tenantId: "t", userId: "u" };

class ListSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  lists = 0;
  items: ContextItem[];
  constructor(
    readonly id: string,
    n: number,
  ) {
    this.items = Array.from({ length: n }, (_, i) => this.make(`m${i}`, `Note ${i} about the plan`, T0 - i * HOUR));
  }
  make(ref: string, text: string, at: number): ContextItem {
    return { id: itemId(this.id, ref), sourceId: this.id, ref, title: ref, text, updatedAt: at };
  }
  async search(_q: SearchQuery): Promise<ContextItem[]> {
    return [];
  }
  async list(_s: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.lists++;
    const sorted = [...this.items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
}

function make(config: Record<string, unknown>, n = 4) {
  let clock = T0;
  const src = new ListSource("mail", n);
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: { sync: true, syncPageSize: 10, syncCallsPerMin: 600, ...config },
  });
  partner.sync!.track(scope, clock);
  const warm = async () => {
    for (let i = 0; i < 10 && !partner.sync!.warm(scope); i++) await partner.sync!.tick();
  };
  const tick = async (ms = 60_000) => {
    clock += ms;
    partner.sync!.track(scope, clock);
    await partner.sync!.tick();
  };
  return { partner, cache, src, warm, tick, advance: (ms: number) => (clock += ms), now: () => clock };
}

describe("push sync: when a source starts pushing", () => {
  test("a watch declared on a source last polled long ago is not current until one poll reads it", async () => {
    const { partner, src, cache, warm, tick, advance, now } = make({ syncPush: true });
    await warm();
    advance(20 * HOUR);
    // Changed before the watch existed: no notice will ever name it.
    src.items.push(src.make("pre", "Kestrel is frozen", now()));
    expect(partner.sync!.current(scope, "mail", now())).toBe(false);
    partner.sourcePushes(scope, "mail");
    expect(partner.sync!.current(scope, "mail", now())).toBe(false);
    expect(partner.sync!.confirmed(scope, "mail", now())).toBe(false);
    const before = src.lists;
    await tick();
    expect(src.lists - before).toBe(1);
    expect(cache.get(scope, itemId("mail", "pre"), now())).not.toBeNull();
    expect(partner.sync!.confirmed(scope, "mail", now())).toBe(true);
    // Declaring it again is not a new start: it stays current.
    partner.sourcePushes(scope, "mail");
    expect(partner.sync!.current(scope, "mail", now())).toBe(true);
  });

  test("a first notice that only names deletions also leaves the source to one poll", async () => {
    const { partner, src, warm, advance, now } = make({ syncPush: true });
    await warm();
    advance(20 * HOUR);
    src.items.push(src.make("pre", "Kestrel is frozen", now()));
    partner.sourceChanged(scope, "mail", { deleted: [itemId("mail", "m3")] });
    expect(partner.sync!.current(scope, "mail", now())).toBe(false);
  });

  test("a notice that arrives during the backfill is read after it", async () => {
    const { partner, src, cache, tick, now } = make({ syncPush: true, syncPageSize: 2, syncCallsPerMin: 1 }, 6);
    const step = () => tick(5 * 60_000);
    await step(); // The first page (the newest two) is read.
    expect(partner.sync!.warm(scope)).toBe(false);
    // The newest item changes after its page was read; the tenant relays the notice.
    src.items[0] = src.make("m0", "Kestrel is frozen", now());
    partner.sourcePushes(scope, "mail");
    partner.sourceChanged(scope, "mail");
    while (!partner.sync!.warm(scope)) await step();
    // Warm, but the notice is still unread: not current until a poll reads it.
    expect(partner.sync!.current(scope, "mail", now())).toBe(false);
    for (let i = 0; i < 3; i++) await step();
    expect(cache.get(scope, itemId("mail", "m0"), now())?.text).toContain("Kestrel");
    expect(partner.sync!.current(scope, "mail", now())).toBe(true);
  });
});

describe("push sync: the notice contract", () => {
  const watched = async (config: Record<string, unknown> = {}) => {
    const x = make({ syncPush: true, ...config });
    await x.warm();
    x.partner.sourcePushes(scope, "mail");
    await x.tick();
    expect(x.partner.sync!.current(scope, "mail", x.now())).toBe(true);
    return x;
  };

  test("a notice with an empty deleted list is a change notice", async () => {
    const { partner, src, now } = await watched();
    src.items.push(src.make("new", "Kestrel is frozen", now()));
    partner.sourceChanged(scope, "mail", { deleted: [] });
    expect(partner.sync!.current(scope, "mail", now())).toBe(false);
  });

  test("a notice with deletions and changed: true drops the items and is read with a poll", async () => {
    const { partner, cache, now } = await watched();
    const id = itemId("mail", "m1");
    partner.sourceChanged(scope, "mail", { deleted: [id], changed: true });
    expect(cache.get(scope, id, now())).toBeNull();
    expect(partner.sync!.current(scope, "mail", now())).toBe(false);
  });

  test("a deletion may name the connector's ref instead of Eden's id", async () => {
    const { partner, cache, now } = await watched();
    partner.sourceChanged(scope, "mail", { deleted: ["m2"] });
    expect(cache.get(scope, itemId("mail", "m2"), now())).toBeNull();
    expect(partner.sync!.current(scope, "mail", now())).toBe(true);
  });

  test("a deletion naming the raw ref of an item whose ref was redacted drops its hashed id", async () => {
    const x = make({ syncPush: true });
    const ref = "msg-" + "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const raw = x.src.make(ref, "A note about the plan", T0);
    x.src.items.push(raw);
    await x.warm();
    x.partner.sourcePushes(scope, "mail");
    await x.tick();
    const id = sanitizedId(raw);
    expect(id).not.toBe(raw.id);
    expect(x.cache.get(scope, id, x.now())).not.toBeNull();
    x.partner.sourceChanged(scope, "mail", { deleted: [ref] });
    expect(x.cache.get(scope, id, x.now())).toBeNull();
    expect(x.partner.sync!.stats.unmatchedDeletes).toBe(0);
  });

  test("deleted ids that match nothing are counted, and nothing is dropped", async () => {
    const { partner, cache, now } = await watched();
    partner.sourceChanged(scope, "mail", { deleted: ["nope", itemId("mail", "gone")] });
    expect(partner.sync!.stats.unmatchedDeletes).toBe(2);
    for (let i = 0; i < 4; i++) expect(cache.get(scope, itemId("mail", `m${i}`), now())).not.toBeNull();
  });
});

const BODY = "Do not share the deck externally.";
const mail = (ref: string, title: string, text = BODY): ContextItem => ({
  id: `mail:${ref}`,
  sourceId: "mail",
  ref,
  title,
  text,
});

/** Cards whose entity is the first word of the item's title, as a model reading the title would write. */
class TitleMaker implements CardMaker {
  sent: number[] = [];
  async make(items: ContextItem[]) {
    this.sent.push(items.length);
    return {
      cards: items.map((i): Card => ({
        kind: "prohibition",
        actions: ["share-external"],
        entities: [i.title.replace(/^re:\s*/i, "").split(" ")[0]!],
        statement: `${i.title}: do not share`,
      })),
      costUsd: 0,
    };
  }
}

describe("sentence reuse (cardsEconomy)", () => {
  test("the same sentence under another subject is another key, and its item gets its own card", async () => {
    expect(sentenceKey(mail("a", "Atlas pricing"))).not.toBe(sentenceKey(mail("b", "Kestrel pricing")));
    const maker = new TitleMaker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => T0 });
    e.economize();
    e.enqueue(scope, [mail("a", "Atlas pricing"), mail("b", "Kestrel pricing")]);
    await e.idle();
    expect(maker.sent).toEqual([2]);
    expect(e.cardsOf(scope, ["mail:b"], T0 + 1).get("mail:b")?.entities).toEqual(["Kestrel"]);
    expect(e.cardsOf(scope, ["mail:a"], T0 + 1).get("mail:a")?.entities).toEqual(["Atlas"]);
  });

  test("a reply or forward under the same subject keeps the key; a dated subject has none", () => {
    const key = sentenceKey(mail("a", "Atlas pricing"));
    expect(key).toBeDefined();
    expect(sentenceKey(mail("r", "Re: Atlas  pricing"))).toBe(key);
    expect(sentenceKey(mail("f", "Fwd: RE: atlas pricing", `Hi all, ${BODY}`))).toBe(key);
    expect(sentenceKey(mail("d", "Atlas pricing tomorrow"))).toBeUndefined();
  });

  test("a sentence key goes with the card it points to: the item leaving takes both", async () => {
    const maker = new TitleMaker();
    const e = new CardEnricher({ maker, budget: new Budget(), now: () => T0 });
    e.economize();
    e.enqueue(scope, [mail("a", "Atlas pricing")]);
    await e.idle();
    const u = (e as unknown as { users: Map<string, { bySentence: Map<string, string> }> }).users.get("t/u")!;
    expect(u.bySentence.size).toBe(1);
    e.forgetItems(scope, ["mail:a"]);
    expect(u.bySentence.size).toBe(0);
    // The same sentence later is read afresh: no card of the gone item is lent to it.
    e.enqueue(scope, [mail("b", "Atlas pricing", `Morning, ${BODY}`)]);
    await e.idle();
    expect(maker.sent).toEqual([1, 1]);
  });
});

describe("a cut batch's retry over budget", () => {
  test("counts only the items the cut call left uncovered", async () => {
    const card: Card = {
      kind: "prohibition",
      actions: ["share-external"],
      entities: ["deck"],
      statement: "no sharing",
    };
    class HalfCut implements CardMaker {
      async make(items: ContextItem[]) {
        return { cards: items.map((_, i) => (i === 0 ? card : null)), costUsd: 0.0001, truncated: true };
      }
    }
    // Room for one reserved call only.
    const budget = new Budget({ usdPerUserDay: 0.002, usdPerSession: Infinity, callsPerSession: Infinity });
    const e = new CardEnricher({ maker: new HalfCut(), budget, now: () => T0 });
    e.enqueue(scope, [mail("a", "Deck", BODY), mail("b", "Deck two", BODY), mail("c", "Deck three", BODY)]);
    await e.idle();
    expect(e.stats.retries).toBe(0);
    expect(e.stats.overBudget).toBe(2);
    expect(e.cardsOf(scope, ["mail:a"], T0 + 1).size).toBe(1);
  });
});
