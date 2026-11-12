import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner, type PushPoolReport } from "./partner";
import { CORE_CONFIG } from "./parts";
import { PushChecker } from "./push-check";

// `pushDaySeats` (G1, D1400, in the default since D1402): a plan with a day is an action on that day. Items on a day
// the request names take seats in the push's pool where the check reads them, whatever their words; a turn that
// names a coming day starts the push; the request's days are read past `timeWindow`.

// Tuesday 27 October 2026.
const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string, ageH = 30, sourceId = "mail"): ContextItem => ({
  id: `${sourceId}:${id}`,
  sourceId,
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * 3_600_000,
});
const ITEMS = [
  // Shares the request's words and is constraint-worded: it opens the gate.
  item("hold", "Sofa delivery", "The sofa delivery must not be left in the lobby: bring it straight up."),
  item("plain", "Sofa order", "Your sofa order is confirmed. Delivery slot to follow."),
  // On the request's day (Saturday 31 October) with none of its words: a span, a written date, a bulk mail.
  item("lift", "Goods lift", "The goods lift will be out of service from Fri 30 Oct to Fri 6 Nov for refurbishment."),
  item("dentist", "Appointment", "Dr Okafor, Sat 31 Oct 2026, 08:30. Please arrive ten minutes early."),
  {
    ...item("promo", "Weekend deals", "Sat 31 Oct only: 20% off everything. Unsubscribe at any time."),
    meta: { category: "promotions" },
  },
  // Another day entirely.
  item("later", "Boiler service", "Engineer booked for Thu 19 Nov, 09:00-12:00."),
];
const REQUEST = "Arrange the sofa delivery for Saturday.";

function numbers(req: ChatRequest): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of req.messages.at(-1)!.content.matchAll(/<item n="(\d+)"[^>]*>([^:]*):/g)) out.set(m[2]!, Number(m[1]));
  return out;
}
const says = (yes: string[]) =>
  new FakeModel((req) => {
    const n = numbers(req);
    const entries = yes
      .filter((t) => n.has(t))
      .map((t) => `{"i":${n.get(t)},"on":"${t}","hits":"the delivery on Saturday","act":true}`);
    return `{"items":[${entries.join(",")}]}`;
  });

function setup(config: Record<string, unknown>, model: Model | null, pools: PushPoolReport[] = [], items = ITEMS) {
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => items };
  const checker = model ? new PushChecker({ model, budget: new Budget() }) : undefined;
  return new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: {
      ...CORE_CONFIG,
      askReader: true,
      readerPush: true,
      readerGate: true,
      confidentScore: 99,
      fallbackMatchedTerms: 99,
      pushCandidates: 2,
      pushCheck: true,
      ...config,
    },
    ...(checker ? { checker } : {}),
    onPushPool: (r) => pools.push(r),
  });
}

const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
async function handed(p: ContextPartner, text = REQUEST, at = ref): Promise<string[]> {
  await p.observe({ ...at, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  const got = p.takePending(at).find((x) => x.reason.startsWith("candidates:"));
  return got ? got.citations.map((c) => c.itemId) : [];
}

describe("pushDaySeats (G1, D1400): items on the request's day are seated where the check reads them", () => {
  test("3 in the default (D1402), out with the part `days`; the config check knows its range", () => {
    expect(DEFAULT_CONFIG.pushDaySeats).toBe(3);
    expect(CORE_CONFIG.pushDaySeats).toBe(0);
    expect(() => checkEngineConfig({ pushDaySeats: 9 })).toThrow();
  });

  test("off: the day's items that share no word with the request are not in the pool", async () => {
    const pools: PushPoolReport[] = [];
    const p = setup({}, says(["Goods lift"]), pools);
    expect(await handed(p)).toEqual([]);
    expect(pools.at(-1)!.pool).not.toContain("mail:lift");
  });

  test("on: they sit after the first candidates, span first, bulk mail and other days out", async () => {
    const pools: PushPoolReport[] = [];
    const p = setup({ pushDaySeats: 3 }, says(["Goods lift"]), pools);
    expect(await handed(p)).toEqual(["mail:lift"]);
    const pool = pools.at(-1)!.pool;
    expect(pool.slice(0, 2).sort()).toEqual(["mail:hold", "mail:plain"]);
    expect(pool.slice(2)).toEqual(["mail:lift", "mail:dentist"]);
  });

  test("the seats are capped", async () => {
    const pools: PushPoolReport[] = [];
    const p = setup({ pushDaySeats: 1 }, says([]), pools);
    await handed(p);
    expect(pools.at(-1)!.pool.slice(2)).toEqual(["mail:lift"]);
  });

  test("a seat is the check's to name: with no checker the push hands what it handed before", async () => {
    const off = await handed(setup({}, null));
    const on = await handed(setup({ pushDaySeats: 3 }, null));
    expect(on).toEqual(off);
    expect(on).not.toContain("mail:lift");
  });

  // The review's probe: no constraint-worded item among the request's own matches, one among the day's.
  const QUIET = [
    item("plain", "Sofa order", "Your sofa order is confirmed. Delivery slot to follow."),
    item("plain2", "Sofa fabric", "The sofa fabric sample you asked about is in stock."),
    item(
      "lift",
      "Goods lift",
      "Out of service from Fri 30 Oct to Fri 6 Nov. Deliveries must not be booked in this period.",
    ),
  ];
  const down = () =>
    new FakeModel(() => {
      throw new Error("down");
    });

  test("a constraint-like seat never opens a hand-out no model judged", async () => {
    // No checker, and a checker that fails: silent with the seats off, and silent with them on.
    for (const model of [null, down()]) {
      expect(await handed(setup({}, model, [], QUIET))).toEqual([]);
      expect(await handed(setup({ pushDaySeats: 3 }, model ? down() : null, [], QUIET))).toEqual([]);
    }
    // With an answer, the seat is the check's to name.
    expect(await handed(setup({ pushDaySeats: 3 }, says(["Goods lift"]), [], QUIET))).toEqual(["mail:lift"]);
  });

  test("an on-day item the pool already held is handed as before when no check answers", async () => {
    // The dentist's mail shares the request's word here, so the pool holds it with the seats off too.
    const items = [
      { ...ITEMS[0]!, meta: { category: "promotions" } },
      item("dentist", "Sofa and dentist", "Dentist Sat 31 Oct 2026, 08:30, then the sofa delivery."),
      ITEMS[1]!,
    ];
    const off = await handed(setup({}, null, [], items));
    expect(await handed(setup({ pushDaySeats: 3 }, null, [], items))).toEqual(off);
  });

  test("a failed check hands no seat either", async () => {
    const failing = new FakeModel(() => {
      throw new Error("down");
    });
    const ids = await handed(setup({ pushDaySeats: 3 }, failing));
    expect(ids).not.toContain("mail:lift");
    expect(ids).not.toContain("mail:dentist");
  });

  test("a bare day of the month is the request's day", async () => {
    const pools: PushPoolReport[] = [];
    const p = setup({ pushDaySeats: 3 }, says(["Appointment"]), pools);
    expect(await handed(p, "Arrange the sofa delivery for the 31st.")).toEqual(["mail:dentist"]);
  });

  test("a window of more than three days seats nothing", async () => {
    const pools: PushPoolReport[] = [];
    const p = setup({ pushDaySeats: 3 }, says(["Goods lift"]), pools);
    await handed(p, "Arrange the sofa delivery for next week.");
    expect(pools.at(-1)!.pool).not.toContain("mail:lift");
  });

  test("a frozen user is thawed for the scan and reads the same", () => {
    // Ticks run by hand (`expireIdle`): frozen warm after two idle ticks.
    const cache = new ItemCache({ freezeIdleMs: 5, warmIdleMs: 1, expireEveryMs: 1 });
    cache.close();
    const scope = { tenantId: "t", userId: "u1" };
    cache.put(scope, ITEMS, NOW);
    const days = new Set(["2026-10-31"]);
    const ids = () => cache.dated(scope, days, () => false, NOW, 5, 0).map((h) => h.item.id);
    const live = ids();
    for (let i = 0; i < 3; i++) cache.expireIdle(NOW);
    expect(cache.frozenCount).toBe(1);
    expect(ids()).toEqual(live);
    expect(live.length).toBeGreaterThan(0);
  });

  test("isolation: the scan reads the asking user's cache only (tenant and user)", () => {
    const cache = new ItemCache();
    const days = new Set(["2026-10-31"]);
    cache.put({ tenantId: "t", userId: "u1" }, ITEMS, NOW);
    cache.put({ tenantId: "t", userId: "u2" }, [ITEMS[0]!, ITEMS[5]!], NOW);
    const ids = (tenantId: string, userId: string) =>
      cache.dated({ tenantId, userId }, days, () => false, NOW, 5, 0).map((h) => h.item.id);
    expect(ids("t", "u1")).toEqual(["mail:lift", "mail:dentist", "mail:promo"]);
    expect(ids("t", "u2")).toEqual([]);
    expect(ids("t2", "u1")).toEqual([]);
  });
});

describe("pushDaySeats: a turn that names a coming day starts the push", () => {
  const gated = { pushOpen: true, pushIndirect: true, pushGate: true, pushCandidates: 5 };
  const PLAN = "The new sofa's being delivered on Saturday.";

  test("off: a plan said as a statement starts no push", async () => {
    const pools: PushPoolReport[] = [];
    await handed(setup(gated, says(["Goods lift"]), pools), PLAN);
    expect(pools.length).toBe(0);
  });

  // A seat that says what must not happen is constraint-like.
  const MUST = ITEMS.map((x) =>
    x.id === "mail:lift" ? { ...x, text: `${x.text} Deliveries must not be booked in this period.` } : x,
  );

  test("on: it starts one, checked and handed when a day seat is itself constraint-like (D1401)", async () => {
    const pools: PushPoolReport[] = [];
    const model = says(["Goods lift"]);
    const ids = await handed(setup({ ...gated, pushDaySeats: 3 }, model, pools, MUST), PLAN);
    expect(pools.length).toBeGreaterThan(0);
    expect(ids).toContain("mail:lift");
    expect(model.calls.length).toBe(1);
  });

  test("on: a day-started push whose seats say nothing constraint-like is not checked and hands nothing", async () => {
    // The pool's own "must not" item (the sofa delivery) does not count: only the day's evidence does.
    const plain = ITEMS.map((x) =>
      x.id === "mail:lift" ? { ...x, text: "Goods lift works: Fri 30 Oct to Fri 6 Nov." } : x,
    );
    const model = says(["Goods lift"]);
    expect(await handed(setup({ ...gated, pushDaySeats: 3 }, model, [], plain), PLAN)).toEqual([]);
    expect(model.calls.length).toBe(0);
    // A push the rule starts is checked as before, whatever its seats.
    const listed = says(["Sofa delivery"]);
    expect(await handed(setup({ ...gated, pushDaySeats: 3 }, listed, [], plain), REQUEST)).toContain("mail:hold");
  });

  test("on: with no checker, or a failed check, a day-started push hands nothing", async () => {
    for (const model of [
      null,
      new FakeModel(() => {
        throw new Error("down");
      }),
    ]) {
      expect(await handed(setup({ ...gated, pushDaySeats: 3 }, model, [], MUST), PLAN)).toEqual([]);
    }
  });

  test("on: a window too long to seat, or a period with no day, starts none", async () => {
    for (const text of ["The sofa's being delivered sometime next week.", "I was really ill for most of this year."]) {
      const pools: PushPoolReport[] = [];
      await handed(setup({ ...gated, pushDaySeats: 3 }, says(["Goods lift"]), pools), text);
      expect(pools.length).toBe(0);
    }
  });

  test("a draft never reads the user's offset (a frozen user stays frozen, D325)", async () => {
    const p = setup({ ...gated, pushDaySeats: 3 }, null);
    const r = await p.observe({ ...ref, at: NOW, kind: "user_message", text: PLAN, draft: true } as AgentEvent);
    expect(r.injection ?? null).toBeNull();
  });

  test("on: chatter, a past day, a short turn and a turn with no day start none", async () => {
    for (const text of [
      "Thanks, see you on Saturday!",
      "The sofa was delivered last Saturday.",
      "Saturday then.",
      "The new sofa's being delivered at some point.",
    ]) {
      const pools: PushPoolReport[] = [];
      await handed(setup({ ...gated, pushDaySeats: 3 }, says(["Goods lift"]), pools), text);
      expect(pools.length).toBe(0);
    }
  });
});
