import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// D140 with a held page: an ask whose on-demand poll uses up the lookup's deadline has no time left to search, so no
// call goes out; a source whose page for the same query the fan-out still holds answers from it ("cached" while fresh,
// "stale" after `freshMs`), and only a source with nothing held is a timeout the answer names.

const scope: Scope = { tenantId: "t", userId: "u" };
const TIMEOUT = 400;
const QUESTION = "Book the train to the quarterly offsite";

function never(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}

/** A synced, notifying source whose listing (and search) hang once `hang` is set. */
class Notes implements Source {
  readonly id = "notes";
  readonly kind = "test";
  readonly description = "notes";
  readonly notifies = true;
  hang = false;
  async list(_s: Scope, _cursor: string | undefined, _limit: number, signal?: AbortSignal): Promise<ListPage> {
    if (this.hang) return never(signal);
    return { items: [], next: null };
  }
  async search(_q: SearchQuery, signal?: AbortSignal): Promise<ContextItem[]> {
    if (this.hang) return never(signal);
    return [];
  }
}

/** A search-only source that always answers. */
class Mail implements Source {
  readonly id = "mail";
  readonly kind = "test";
  readonly description = "mail";
  searches = 0;
  async search(q: SearchQuery): Promise<ContextItem[]> {
    this.searches++;
    const item: ContextItem = {
      id: itemId("mail", "m1"),
      sourceId: "mail",
      ref: "m1",
      title: "Quarterly offsite",
      text: "The quarterly offsite is in Lisbon on 12 November; book the train before Friday.",
      updatedAt: Date.now() - 3_600_000,
    };
    return q.text.toLowerCase().includes("offsite") ? [item] : [];
  }
}

async function setup() {
  const notes = new Notes();
  const mail = new Mail();
  let skew = 0;
  const now = () => Date.now() + skew;
  const partner = new ContextPartner({
    sources: async () => [notes, mail],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now,
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPush: true,
      syncOnDemand: true,
      sourceTimeoutMs: TIMEOUT,
    },
  });
  partner.sync!.track(scope, now());
  while (!partner.sync!.warm(scope)) await partner.sync!.tick();
  const ask = (sessionId: string) => partner.ask({ ...scope, sessionId, question: QUESTION });
  // The first ask, with every source answering: the fan-out now holds mail's page for this query.
  const first = await ask("s0");
  // Then notes says it changed and stops answering: the next ask's poll hangs to the deadline.
  partner.sourceChanged(scope, "notes");
  notes.hang = true;
  return { partner, mail, first, ask, advance: (ms: number) => (skew += ms) };
}

const statusOf = (r: { sources?: { sourceId: string; status: string }[] }, id: string) =>
  r.sources?.find((x) => x.sourceId === id)?.status;

describe("D140: a poll that uses up the deadline still serves the pages the fan-out holds", () => {
  test("a fresh held page answers as cached, with no call; only the source with nothing held timed out", async () => {
    const { mail, first, ask } = await setup();
    expect(statusOf(first, "mail")).toBe("ok");
    const searches = mail.searches;
    const t0 = performance.now();
    const r = await ask("s1");
    expect(performance.now() - t0).toBeGreaterThan(TIMEOUT - 100); // The poll did use up the deadline.
    expect(mail.searches).toBe(searches); // No call: there was no time for one.
    expect(statusOf(r, "mail")).toBe("cached");
    expect(r.answer).toContain("Lisbon");
    expect(r.answer).not.toContain("Could not reach mail");
    expect(r.answer).toContain("Could not reach notes");
  }, 10_000);

  test("a page past freshMs (60 s) but not expired answers as stale; past staleMs (600 s) nothing is held", async () => {
    const { mail, ask, advance } = await setup();
    advance(120_000);
    const searches = mail.searches;
    const r = await ask("s1");
    expect(mail.searches).toBe(searches);
    expect(statusOf(r, "mail")).toBe("stale");
    expect(r.answer).not.toContain("Could not reach mail");
    advance(600_000);
    // Long after the last poll gave up, notes is polled again and hangs again: mail's page has expired, so nothing
    // answers it and it is named as a timeout, with no call.
    const later = await ask("s2");
    expect(mail.searches).toBe(searches);
    expect(statusOf(later, "mail")).toBe("timeout");
    expect(later.answer).toContain("Could not reach");
  }, 10_000);
});
