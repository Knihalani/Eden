import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// F3 (`freshenAgeMs`, trial; D1127): a silent edit at a source the request's lookup does not poll otherwise goes out as
// the pre-edit copy (D1126: 12 of 26 handed silent facts on dev20, none raised). With the switch, a cached copy no read
// has refreshed for longer than the setting is re-read by its ref before it is handed, as a doubted copy is (D126);
// a sent message (mail, chat) is never re-read; a failed re-read hands the cached copy (fail open).

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9);
const scope: Scope = { tenantId: "t", userId: "u" };

/** A source that never notifies; `fetches` counts re-reads by ref; `fail` makes them throw. */
class Quiet implements Source {
  readonly kind = "test";
  readonly description = "notes";
  readonly fetchReportsGone = true;
  readonly fetchesById = true;
  docs = new Map<string, { title: string; text: string; at: number }>();
  fetches: string[] = [];
  fail = false;
  constructor(readonly id: string) {}
  item(ref: string): ContextItem | null {
    const d = this.docs.get(ref);
    return d
      ? { id: itemId(this.id, ref), sourceId: this.id, ref, title: d.title, text: d.text, updatedAt: d.at }
      : null;
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    return [...this.docs.keys()]
      .map((r) => this.item(r)!)
      .filter((i) => words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)));
  }
  async list(_s: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const all = [...this.docs.keys()].map((r) => this.item(r)!);
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches.push(ref);
    if (this.fail) throw new Error("503 Service Unavailable");
    return this.item(ref);
  }
}

const OLD = "Pepper's meds: Felimazole 2.5 mg once a day in the morning feed.";
const NEW = "Pepper's meds: Felimazole 2.5 mg twice a day, 8am and 8pm, by hand.";

async function run(freshenAgeMs: number, opts: { fail?: boolean; mail?: boolean; ageMin?: number } = {}) {
  let clock = T0;
  const src = new Quiet("notes");
  const text = (t: string) => (opts.mail ? `From: Vet <vet@x.com>\nDate: Mon, 2 Nov 2026 08:00\n\n${t}` : t);
  src.docs.set("pepper", { title: "Pepper meds", text: text(OLD), at: T0 - 60 * MIN });
  const partner = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      ...CORE_CONFIG,
      confidentScore: 0.1,
      minMatchedTerms: 1,
      sync: true,
      syncPageSize: 100,
      // The request's lookup answers from the index: no on-demand poll of the source (the case D1126 found).
      syncOnDemand: false,
      verifyDelivery: true,
      freshenAgeMs,
    },
  });
  partner.sync!.track(scope, clock);
  while (!partner.sync!.warm(scope)) await partner.sync!.tick();
  // Edited at its source with no notice; no read since.
  src.docs.set("pepper", { title: "Pepper meds", text: text(NEW), at: clock });
  src.fail = opts.fail === true;
  clock += (opts.ageMin ?? 30) * MIN;
  const r = await partner.observe(
    {
      ...scope,
      sessionId: "s1",
      at: clock,
      kind: "user_message",
      text: "Remind me about Pepper meds while we are away",
    } as AgentEvent,
    { waitMs: 2_000 },
  );
  const got = [r.injection, ...partner.takePending({ ...scope, sessionId: "s1" })].filter(
    (x): x is Injection => x !== null,
  );
  return { text: got.map((g) => g.text).join("\n"), fetches: src.fetches.length };
}

describe("freshenAgeMs (D1127)", () => {
  test("off: the cached pre-edit copy is handed", async () => {
    const { text, fetches } = await run(0);
    expect(text).toContain("once a day");
    expect(fetches).toBe(0);
  });

  test("on: an aged copy is re-read by its ref and the edited version is handed", async () => {
    const { text, fetches } = await run(10 * MIN);
    expect(text).toContain("twice a day");
    expect(text).not.toContain("once a day");
    expect(fetches).toBe(1);
  });

  test("on: a copy read more recently than the setting is not re-read", async () => {
    const { text, fetches } = await run(60 * MIN, { ageMin: 5 });
    expect(text).toContain("once a day");
    expect(fetches).toBe(0);
  });

  test("on: a sent message is never re-read", async () => {
    const { fetches } = await run(10 * MIN, { mail: true });
    expect(fetches).toBe(0);
  });

  test("on: a failed re-read hands the cached copy (fail open)", async () => {
    const { text, fetches } = await run(10 * MIN, { fail: true });
    expect(fetches).toBeGreaterThanOrEqual(1);
    expect(text).toContain("once a day");
  });
});
