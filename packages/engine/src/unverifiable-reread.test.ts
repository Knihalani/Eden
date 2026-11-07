import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import type { ListPage, SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";

// A8 (A5's lead): a re-read whose null proves nothing (an MCP source, `fetchReportsGone` false) is "unverifiable" and
// the item is cited as held (D126, D211). Before the fix its copy stayed doubted, so every later ask or delivery past
// the 30 s reuse window, and every other session of the user, fetched it again for the same answer, until a poll or
// sweep listed it again. Now the outcome stands for the user until the source's next signal.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 2, 9);
const HOLD = itemId("mail", "hold");

class McpMail implements Source {
  readonly id = "mail";
  readonly kind = "test";
  readonly description = "mail";
  readonly notifies = true;
  readonly fetchReportsGone = false;
  fetches = 0;
  items = new Map<string, ContextItem>();
  add(ref: string, title: string, text: string, at: number): void {
    this.items.set(ref, { id: itemId(this.id, ref), sourceId: this.id, ref, title, text, updatedAt: at });
  }
  async search(q: SearchQuery): Promise<ContextItem[]> {
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
    return this.items.get(ref) ?? null;
  }
}

async function setup() {
  let clock = T0;
  const src = new McpMail();
  // The oldest item, so a poll's newest page does not list it again: only a fetch can speak for it.
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
  const users = [
    { tenantId: "t1", userId: "u1" },
    { tenantId: "t1", userId: "u2" },
  ];
  for (const user of users) {
    p.sync!.track(user, clock);
    while (!p.sync!.warm(user)) {
      clock += 1_000;
      await p.sync!.tick();
    }
  }
  clock += 10 * 60_000;
  const ask = (user: Scope, sessionId = "s1") =>
    p.ask({ ...user, sessionId, question: "Is the Harlow invoice on hold?" });
  const advance = (ms: number) => (clock += ms);
  return { p, src, users, ask, advance };
}

const cited = (r: { citations: { itemId: string }[] }) => r.citations.map((c) => c.itemId);

describe("an unverifiable re-read stands until the source's next signal (A8)", () => {
  test("asks 31 s apart after one signal: one fetch, the same answer each time", async () => {
    const { p, src, users, ask, advance } = await setup();
    const u = users[0]!;
    src.items.delete("hold"); // Gone, but the MCP source's null cannot say so.
    expect(p.sourceChanged(u, "mail")).toBe(true);
    advance(60_000);
    for (let i = 0; i < 6; i++) {
      expect(cited(await ask(u))).toContain(HOLD); // Unverifiable: cited as held (D211), every time.
      advance(31_000);
    }
    expect(src.fetches).toBe(1);
  });

  test("other sessions of the same user reuse it; a new signal re-reads", async () => {
    const { p, src, users, ask, advance } = await setup();
    const u = users[0]!;
    src.items.delete("hold");
    p.sourceChanged(u, "mail");
    advance(60_000);
    for (let s = 0; s < 4; s++) {
      expect(cited(await ask(u, `s${s}`))).toContain(HOLD);
      advance(1_000);
    }
    expect(src.fetches).toBe(1);
    p.sourceChanged(u, "mail");
    advance(60_000);
    await ask(u, "s9");
    expect(src.fetches).toBe(2);
  });

  test("per user: another user's doubted copy of the same item is re-read on its own (D9)", async () => {
    const { p, src, users, ask, advance } = await setup();
    const [u1, u2] = [users[0]!, users[1]!];
    src.items.delete("hold");
    p.sourceChanged(u1, "mail");
    p.sourceChanged(u2, "mail");
    advance(60_000);
    await ask(u1);
    expect(src.fetches).toBe(1);
    await ask(u2);
    expect(src.fetches).toBe(2);
    advance(31_000);
    await ask(u1);
    await ask(u2);
    expect(src.fetches).toBe(2);
  });

  test("forgetting the user drops what was held", async () => {
    const { p, src, users, ask, advance } = await setup();
    const u = users[0]!;
    src.items.delete("hold");
    p.sourceChanged(u, "mail");
    advance(60_000);
    await ask(u);
    expect(src.fetches).toBe(1);
    expect((p as unknown as { unverifiable: Map<string, unknown> }).unverifiable.size).toBe(1);
    p.forget(u);
    expect((p as unknown as { unverifiable: Map<string, unknown> }).unverifiable.size).toBe(0);
  });
});
