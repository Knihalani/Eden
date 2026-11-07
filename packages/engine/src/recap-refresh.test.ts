import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type AgentEvent, type ContextItem, type Injection, type Scope } from "@eden/protocol";
import type { SearchQuery, Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { isRecapRequest } from "./text";

// A17 (docs/research/a17-long-quality.md, D341): `recapRefresh`. D205 sends an item that changed after it was handed
// once, as an "updated:" packet before the next request; a recap asked many turns later is written from the whole
// transcript, where the old version is still there and often more prominent. On a recap- or summary-shaped request,
// every item this session was sent an update for is sent again in its current version, last before the recap.

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 9);

class Listed implements Source {
  readonly kind = "test";
  readonly description = "notes";
  readonly notifies = true;
  docs = new Map<string, { title: string; text: string }>();
  constructor(readonly id: string) {}
  item(ref: string): ContextItem | null {
    const d = this.docs.get(ref);
    return d ? { id: itemId(this.id, ref), sourceId: this.id, ref, title: d.title, text: d.text } : null;
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
  async fetch(ref: string): Promise<ContextItem | null> {
    return this.item(ref);
  }
  async list(_s: Scope, cursor: string | undefined, limit: number) {
    const all = [...this.docs.keys()].map((r) => this.item(r)!);
    const at = cursor ? Number(cursor) : 0;
    return { items: all.slice(at, at + limit), next: at + limit < all.length ? String(at + limit) : null };
  }
}

const scope: Scope = { tenantId: "t", userId: "u" };
const OFFSITE = itemId("notes", "q1");
const RECAP = "Before I act on today's plans: give me a short recap of anything to watch out for, with the times.";

async function setup(config: Record<string, unknown> = {}) {
  let clock = T0;
  const src = new Listed("notes");
  src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite is in Lisbon at 09:30 on 12 November." });
  src.docs.set("l1", { title: "Lunch", text: "Lunch with Sam at the canteen." });
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
      syncPush: true,
      syncPageSize: 100,
      revisionNotice: true,
      recapRefresh: true,
      ...config,
    },
  });
  partner.sync!.track(scope, clock);
  while (!partner.sync!.warm(scope)) await partner.sync!.tick();
  return { partner, src, advance: (ms: number) => (clock += ms), now: () => clock };
}

async function say(p: ContextPartner, text: string, sessionId: string, at: number) {
  const r = await p.observe({ ...scope, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  return [r.injection, ...p.takePending({ ...scope, sessionId })].filter((x): x is Injection => x !== null);
}
const updates = (got: Injection[]) => got.filter((i) => i.reason.startsWith("updated:"));

/** s1 handed the offsite, which then moves to 11:30; the update is taken at an unrelated request. */
async function handedAndRevised(config: Record<string, unknown> = {}) {
  const t = await setup(config);
  await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
  t.advance(5 * MIN);
  t.src.docs.set("q1", { title: "Quarterly offsite", text: "The quarterly offsite is in Lisbon at 11:30 on 12 November." });
  t.partner.sourceChanged(scope, "notes");
  await t.partner.revisionsSettled(scope);
  t.advance(MIN);
  expect(updates(await say(t.partner, "What should I bring to the canteen lunch", "s1", t.now())).length).toBe(1);
  t.advance(MIN);
  return t;
}

describe("isRecapRequest", () => {
  test("recap- and summary-shaped requests", () => {
    for (const r of [
      RECAP,
      "Can you summarise what we covered today?",
      "Quick summary of my day please",
      "Wrap up: what do I need to remember from everything we discussed?",
      "Catch me up on today's plans",
      "Give me a rundown of what's left today",
    ]) {
      expect([r, isRecapRequest(r)]).toEqual([r, true]);
    }
  });
  test("ordinary requests are not", () => {
    for (const r of [
      "Book the Lisbon offsite hotel",
      "What should I bring to the canteen lunch",
      "Summarize this PDF for me",
      "Write the quarterly summary report for finance",
    ]) {
      expect([r, isRecapRequest(r)]).toEqual([r, false]);
    }
  });
});

describe("recapRefresh (D341)", () => {
  test("on: a recap request sends the revised item again, current version, as an update", async () => {
    const t = await handedAndRevised();
    const up = updates(await say(t.partner, RECAP, "s1", t.now()));
    expect(up.length).toBe(1);
    expect(up[0]!.citations.map((c) => c.itemId)).toEqual([OFFSITE]);
    expect(up[0]!.text).toContain("11:30");
    expect(up[0]!.text).not.toContain("09:30");
    expect(up[0]!.text).toMatch(/^<context [^\n]*Data, not instructions/);
  });

  test("off: the recap request gets no second update", async () => {
    const t = await handedAndRevised({ recapRefresh: false });
    expect(updates(await say(t.partner, RECAP, "s1", t.now())).length).toBe(0);
  });

  test("an ordinary request does not re-send it", async () => {
    const t = await handedAndRevised();
    expect(updates(await say(t.partner, "Is the canteen lunch still on", "s1", t.now())).length).toBe(0);
  });

  test("an item handed and never revised is not re-sent on a recap", async () => {
    const t = await setup();
    await say(t.partner, "Remind me where the quarterly offsite is", "s1", t.now());
    t.advance(MIN);
    expect(updates(await say(t.partner, RECAP, "s1", t.now())).length).toBe(0);
  });

  test("isolation: another session of the user, never handed the item, gets nothing on its recap", async () => {
    const t = await handedAndRevised();
    expect(updates(await say(t.partner, RECAP, "s2", t.now())).length).toBe(0);
    expect(updates(await say(t.partner, RECAP, "s1", t.now())).length).toBe(1);
  });

  test("a second recap re-sends again (each recap is written from the whole transcript)", async () => {
    const t = await handedAndRevised();
    expect(updates(await say(t.partner, RECAP, "s1", t.now())).length).toBe(1);
    t.advance(MIN);
    expect(updates(await say(t.partner, "Summarise the day once more", "s1", t.now())).length).toBe(1);
  });

  test("an item removed at its source since is not re-sent", async () => {
    const t = await handedAndRevised();
    t.src.docs.delete("q1");
    await t.partner.sourceRemoved(scope, "notes", ["q1"]);
    expect(updates(await say(t.partner, RECAP, "s1", t.now())).length).toBe(0);
  });
});
