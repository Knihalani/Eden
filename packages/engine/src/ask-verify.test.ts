import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// D211: an ask's citations a change signal put in doubt are re-read (`verifyItems`, as deliveries are) and a doubted
// item whose re-read could not confirm it is left out and named, never cited as held. RealUse-1 part D found one ask in
// 360 citing a deleted item: its re-read failed (a transient connector error) and the doubted copy was kept.
// D212: an upstream 429 is "throttled" in the fan-out and reads "rate-limited" in the ask's answer, not "failed".

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 9);
const HOLD = itemId("mail", "hold");

/** A notifying mail source whose fetch fails as scripted (one entry per call: an error message, or null to answer). */
class Mail implements Source {
  readonly id = "mail";
  readonly kind = "test";
  readonly description = "mail";
  readonly notifies = true;
  readonly fetchReportsGone = true;
  fetches = 0;
  /** Each fetch takes the next entry: a message to throw, or null to answer from `items`. Past the end: answer. */
  script: (string | null)[] = [];
  /** Thrown by every search (an upstream outage or 429), when set. */
  searchError: string | null = null;
  items = new Map<string, ContextItem>();
  constructor(readonly withFetch = true) {
    if (!withFetch) (this as { fetch?: unknown }).fetch = undefined;
  }
  add(ref: string, title: string, text: string, at: number): void {
    this.items.set(ref, { id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at });
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
    if (this.searchError) throw new Error(this.searchError);
    const words = q.text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);
    // An index that lags the mailbox: it never shows HOLD, so only the synced copy or a fetch can answer for it.
    return [...this.items.values()].filter(
      (i) => i.ref !== "hold" && words.some((w) => `${i.title} ${i.text}`.toLowerCase().includes(w)),
    );
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    const sorted = [...this.items.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const at = cursor ? Number(cursor) : 0;
    return { items: sorted.slice(at, at + limit), next: at + limit < sorted.length ? String(at + limit) : null };
  }
  async fetch(ref: string): Promise<ContextItem | null> {
    this.fetches++;
    const next = this.script.shift();
    if (typeof next === "string") throw new Error(next);
    return this.items.get(ref) ?? null;
  }
}

async function setup(src = new Mail()) {
  let clock = T0;
  // The oldest item, so a poll's newest page does not list it again: only a fetch can tell it is gone.
  src.add(
    "hold",
    "Harlow invoice on hold",
    "Harlow invoice payments are on hold until the dispute ends",
    T0 - 9 * HOUR,
  );
  for (let i = 0; i < 3; i++) src.add(`n${i}`, `Note ${i}`, `Note ${i} about lunch orders`, T0 - (1 + i) * HOUR);
  const p = new ContextPartner({
    sources: async () => [src],
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => clock,
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncPush: true,
      syncOnDemand: true,
      syncPageSize: 1,
      syncPollPageSize: 1,
      syncCallsPerMin: 600,
      verifyDelivery: true,
    },
  });
  const user = { tenantId: "t1", userId: "u1" };
  p.sync!.track(user, clock);
  // A second a tick: the fan-out's rate limit (a burst of 10, two kept for serving) refills between backfill pages.
  while (!p.sync!.warm(user)) {
    clock += 1_000;
    await p.sync!.tick();
  }
  clock += 10 * 60_000;
  const ask = () => p.ask({ ...user, sessionId: "s1", question: "Is the Harlow invoice on hold?" });
  /** The source deletes HOLD and says only that it changed (a signal, D131). */
  const deleteBySignal = () => {
    src.items.delete("hold");
    expect(p.sourceChanged(user, "mail")).toBe(true);
    clock += 60_000;
  };
  return { p, src, user, ask, deleteBySignal };
}

const citedIds = (r: { citations: { itemId: string }[] }) => r.citations.map((c) => c.itemId);

describe("an ask never cites a deleted item a signal put in doubt (D211)", () => {
  test("control: before the deletion the ask cites the held copy, with no re-read", async () => {
    const { src, ask } = await setup();
    expect(citedIds(await ask())).toContain(HOLD);
    expect(src.fetches).toBe(0);
  });

  test("a re-read that fails once (a transient error) is tried again, finds it gone, and it is not cited", async () => {
    const { src, ask, deleteBySignal } = await setup();
    deleteBySignal();
    src.script = ["upstream 503 service unavailable"];
    const r = await ask();
    expect(citedIds(r)).not.toContain(HOLD);
    expect(src.fetches).toBe(2);
    expect(r.answer).not.toContain("Harlow invoice on hold");
  });

  test("a re-read that keeps failing: left out, and the answer says what could not be re-checked", async () => {
    const { src, ask, deleteBySignal } = await setup();
    deleteBySignal();
    src.script = ["upstream 503", "upstream 503"];
    const r = await ask();
    expect(citedIds(r)).not.toContain(HOLD);
    expect(r.answer).not.toBe("Nothing in the connected sources.");
    expect(r.answer).toContain("could not be re-checked");
    expect(r.answer).toContain("mail");
  });

  test("a 429 on the re-read is not retried at once (it would be refused again): left out and named", async () => {
    const { src, ask, deleteBySignal } = await setup();
    deleteBySignal();
    src.script = ["429 Too Many Requests"];
    const r = await ask();
    expect(citedIds(r)).not.toContain(HOLD);
    expect(src.fetches).toBe(1);
    expect(r.answer).toContain("could not be re-checked");
  });

  test("a doubted item that is still there is re-read, confirmed and cited", async () => {
    const { src, p, user, ask } = await setup();
    expect(p.sourceChanged(user, "mail")).toBe(true);
    src.script = ["upstream 503"];
    const r = await ask();
    expect(citedIds(r)).toContain(HOLD);
    expect(src.fetches).toBe(2);
  });

  test("more doubted citations than the fan-out's concurrency: none is left out for a skipped re-read", async () => {
    const src = new Mail();
    // Six more Harlow items, so the ask cites five and re-reads them all at once, past the per-source limit of 2-4.
    const topics = ["freight", "catering", "scaffolding", "licensing", "printing", "cleaning"];
    const people = ["Priya Shah", "Tom Okafor", "Lena Berg", "Marco Ruiz", "Ada Novak", "Sam Lowe"];
    topics.forEach((t, i) =>
      src.add(
        `h${i}`,
        `Harlow invoice ${4100 + i} (${t}) on hold`,
        `${people[i]} says the Harlow ${t} invoice ${4100 + i} is on hold until ${t} receipts arrive in week ${i + 2}`,
        T0 - (10 + i) * HOUR,
      ),
    );
    const { p, user, ask } = await setup(src);
    const before = await ask();
    expect(before.citations.length).toBe(5);
    expect(p.sourceChanged(user, "mail")).toBe(true);
    const r = await ask();
    // Every item is still there: every one is confirmed and cited, and nothing is said to be left out.
    expect(citedIds(r).sort()).toEqual(citedIds(before).sort());
    expect(r.answer).not.toContain("Left out");
  });

  test("a source with no fetch tool cannot be re-read: its items are cited as held, as before (D126)", async () => {
    const { ask, deleteBySignal } = await setup(new Mail(false));
    deleteBySignal();
    expect(citedIds(await ask())).toContain(HOLD);
  });
});

describe("an upstream 429 reads rate-limited, not failed (D212)", () => {
  test("a search refused with 429: status throttled, answer says rate-limited and is not an all-clear", async () => {
    const src = new Mail();
    const { p, user } = await setup(src);
    src.searchError = "MCP error: 429 Too Many Requests";
    // A question the synced copy cannot answer locally makes the ask search the source live.
    p.sync!.forget(user, "mail");
    const r = await p.ask({ ...user, sessionId: "s2", question: "What did the auditor say about Quarry Lane?" });
    expect(r.sources).toEqual([{ sourceId: "mail", status: "throttled" }]);
    expect(r.answer).toContain("mail (rate-limited)");
    expect(r.answer).not.toContain("failed");
    expect(r.answer).toContain("not an all-clear");
  });

  test("a plain error still reads failed", async () => {
    const src = new Mail();
    const { p, user } = await setup(src);
    src.searchError = "upstream 500";
    p.sync!.forget(user, "mail");
    const r = await p.ask({ ...user, sessionId: "s2", question: "What did the auditor say about Quarry Lane?" });
    expect(r.sources).toEqual([{ sourceId: "mail", status: "error" }]);
    expect(r.answer).toContain("mail (failed)");
  });
});
