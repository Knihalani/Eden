import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkPool, type PairChecker } from "./checker";
import { checkEngineConfig } from "./config-check";
import { DEFAULT_CONFIG } from "./config";
import { ContextPartner, type PushPoolReport } from "./partner";
import { CORE_CONFIG } from "./parts";

// I1 (D471), revived by N2 (D510–D513): the `pushCheck` trial. A pair checker scores the push's pool; the candidates
// are the pool's items it passes (in pool order); none passing sends no candidates packet with `pushCheckSilent` and
// the default's otherwise; a checker that fails leaves the default's rule. `pushWiden` adds items past the pool for the
// checker only; `pushCheckReshow` hands again, when the checker passes it, a candidate taken for an earlier request.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string, ageH: number): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * 3_600_000,
});
// Constraint wording on the first, so the default's gate hands candidates.
const ITEMS = [
  item("hold", "Harlow venue", "Payments to Harlow are on hold until the venue deposit dispute ends.", 2),
  item("plain", "Harlow invoice", "Harlow invoice for the venue deposit: the PDF is attached.", 3),
  item("dated", "Harlow deposit", "The Harlow venue deposit is due on Friday 30 October.", 4),
  item("other", "Invoice archive", "Older invoice for a venue deposit, paid last year.", 500),
];
const REQUEST = "Pay the Harlow venue deposit invoice, key AKIAIOSFODNN7EXAMPLE.";

/** A checker scoring by item id; records what it was sent. */
function fake(scores: Record<string, number> | "throw" | "short" | "slow") {
  const seen: { request: string; ids: string[] }[] = [];
  const checker: PairChecker = {
    async score(_scope, request, items) {
      seen.push({ request, ids: items.map((x) => x.id) });
      if (scores === "throw") throw new Error("down");
      if (scores === "short") return [0.9];
      if (scores === "slow") await new Promise((r) => setTimeout(r, 200));
      return items.map((x) => (typeof scores === "object" ? (scores[x.id] ?? 0) : 0.9));
    },
  };
  return { checker, seen };
}

function setup(config: Record<string, unknown>, checker: PairChecker | null, pools: PushPoolReport[] = []) {
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };
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
      ...config,
    },
    ...(checker ? { checker } : {}),
    onPushPool: (r) => pools.push(r),
  });
}

const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
async function handed(p: ContextPartner): Promise<string[]> {
  await p.observe({ ...ref, at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, { waitMs: 2_000 });
  const got = p.takePending(ref).find((x) => x.reason.startsWith("candidates:"));
  return got ? got.citations.map((c) => c.itemId) : [];
}

describe("pushCheck (I1, D471): the checker picks the push's candidates", () => {
  test("off in the default; off, the checker is never called", async () => {
    expect(DEFAULT_CONFIG.pushCheck).toBe(false);
    const { checker, seen } = fake({ "mail:other": 0.9 });
    const p = setup({}, checker);
    expect((await handed(p)).length).toBe(2);
    expect(seen.length).toBe(0);
  });

  test("on: items that pass enter in pool order, items that fail leave", async () => {
    const pools: PushPoolReport[] = [];
    const { checker, seen } = fake({ "mail:other": 0.9, "mail:dated": 0.6, "mail:hold": 0.1, "mail:plain": 0.4 });
    const p = setup({ pushCheck: true }, checker, pools);
    const ids = await handed(p);
    expect(new Set(ids)).toEqual(new Set(["mail:dated", "mail:other"]));
    const pool = pools.at(-1)!;
    expect(pool.checked!.length).toBe(pool.pool.length);
    // The checker reads the redacted request (D10), not the raw one.
    expect(seen[0]!.request).toBe(sanitizeForStore(REQUEST));
    expect(seen[0]!.request).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("on: none passing sends no candidates packet with pushCheckSilent (D513), the default's without", async () => {
    const { checker } = fake({});
    expect(await handed(setup({ pushCheck: true, pushCheckSilent: true }, checker))).toEqual([]);
    const plain = await handed(setup({}, null));
    expect(await handed(setup({ pushCheck: true }, fake({}).checker))).toEqual(plain);
  });

  test("the pass mark is the config's", async () => {
    const { checker } = fake({ "mail:plain": 0.4 });
    expect(await handed(setup({ pushCheck: true, pushCheckPass: 0.3 }, checker))).toEqual(["mail:plain"]);
  });

  test("fails open: an error, a wrong-length answer or a late one leaves the default's candidates", async () => {
    const plain = await handed(setup({}, null));
    expect(plain.length).toBe(2);
    for (const mode of ["throw", "short", "slow"] as const) {
      const { checker } = fake(mode);
      expect(await handed(setup({ pushCheck: true, pushCheckWaitMs: 50 }, checker))).toEqual(plain);
    }
  });

  test("checkPool: out-of-range scores fail open; an empty pool is an empty map", async () => {
    const scope = { tenantId: "t", userId: "u" };
    const bad: PairChecker = { score: async (_s, _r, items) => items.map(() => 1.5) };
    expect(await checkPool(bad, scope, "r", [{ id: "a", title: "", text: "" }], 100)).toBeNull();
    expect((await checkPool(bad, scope, "r", [], 100))!.size).toBe(0);
  });

  test("the switch needs a checker: a server (cards, reader) refuses it, the lab accepts it", () => {
    const on = { pushCheck: true };
    expect(() => checkEngineConfig(on, { deps: { cards: true, reader: true } })).toThrow(/checker/);
    expect(checkEngineConfig(on, { deps: { cards: true, reader: true, checker: true } })).toEqual(on);
    expect(() => checkEngineConfig({ pushCheckPass: 1.5 }, { deps: { checker: true } })).toThrow();
  });
});

describe("pushWiden (N2, D511): items past the pool, for the checker only", () => {
  const widen = (ids: string[]) => async (_s: unknown, _r: string, k: number) => ids.slice(0, k);
  function widened(config: Record<string, unknown>, checker: PairChecker, ids: string[], pools: PushPoolReport[]) {
    const extra = item("car", "Audi finance", "Outstanding finance on the Audi: settle it before any sale.", 30);
    const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };
    const cache = new ItemCache();
    const p = new ContextPartner({
      sources: async () => [source],
      sourceMap: new SourceMap(),
      cache,
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
      checker,
      widen: widen(ids),
      onPushPool: (r) => pools.push(r),
    });
    cache.put({ tenantId: "t", userId: "u1" }, [extra], NOW);
    return p;
  }

  test("a widened item the checker passes is handed; one it fails is not; off, it is never read", async () => {
    const pools: PushPoolReport[] = [];
    const { checker, seen } = fake({ "mail:car": 0.9 });
    const p = widened({ pushWiden: true, pushWidenIntent: 0, pushWidenDeep: 0 }, checker, ["mail:car"], pools);
    expect(await handed(p)).toEqual(["mail:car"]);
    expect(seen[0]!.ids).toContain("mail:car");
    // After the pool: the pool's own items keep their places.
    expect(pools.at(-1)!.pool.at(-1)).toBe("mail:car");
    expect(pools.at(-1)!.constraintLike.length).toBe(pools.at(-1)!.pool.length);
    const fail = fake({ "mail:hold": 0.9 });
    const q = widened({ pushWiden: true }, fail.checker, ["mail:car"], []);
    expect(await handed(q)).toEqual(["mail:hold"]);
    const off = fake({ "mail:car": 0.9 });
    const r = widened({}, off.checker, ["mail:car"], []);
    await handed(r);
    expect(off.seen[0]!.ids).not.toContain("mail:car");
  });

  test("a widened item never enters without the checker's answer (fails open to the default's pool)", async () => {
    const plain = await handed(setup({}, null));
    const { checker } = fake("throw");
    expect(await handed(widened({ pushWiden: true }, checker, ["mail:car"], []))).toEqual(plain);
  });

  test("the widen settings need pushWiden and pushCheck", () => {
    expect(() => checkEngineConfig({ pushCheck: true, pushWidenIntent: 3 }, { deps: { checker: true } })).toThrow();
    const ok = { pushCheck: true, pushWiden: true, pushWidenEmbed: 3 };
    expect(checkEngineConfig(ok, { deps: { checker: true } })).toEqual(ok);
  });
});

describe("pushCheckReshow (N2, D512): a candidate taken earlier goes again only when the checker passes it", () => {
  async function twice(config: Record<string, unknown>, scores: Record<string, number>) {
    const { checker } = fake(scores);
    const p = setup({ pushCheck: true, ...config }, checker);
    const first = await handed(p);
    await p.observe({ ...ref, at: NOW + 60_000, kind: "user_message", text: REQUEST } as AgentEvent, {
      waitMs: 2_000,
    });
    const again = p.takePending(ref).find((x) => x.reason.startsWith("candidates:"));
    return { first, second: again ? again.citations.map((c) => c.itemId) : [] };
  }

  test("off: the not-twice ledger keeps it back; on: handed again at the next request", async () => {
    const scores = { "mail:hold": 0.9 };
    const off = await twice({}, scores);
    expect(off.first).toEqual(["mail:hold"]);
    expect(off.second).toEqual([]);
    const on = await twice({ pushCheckReshow: true }, scores);
    expect(on.first).toEqual(["mail:hold"]);
    expect(on.second).toEqual(["mail:hold"]);
  });

  test("on: an item the checker fails for the later request is not re-shown", async () => {
    let n = 0;
    const checker: PairChecker = {
      async score(_s, _r, items) {
        n++;
        return items.map((x) => (x.id === "mail:hold" && n === 1 ? 0.9 : 0));
      },
    };
    const p = setup({ pushCheck: true, pushCheckReshow: true, pushCheckSilent: true }, checker);
    expect(await handed(p)).toEqual(["mail:hold"]);
    await p.observe({ ...ref, at: NOW + 60_000, kind: "user_message", text: REQUEST } as AgentEvent, {
      waitMs: 2_000,
    });
    expect(p.takePending(ref).find((x) => x.reason.startsWith("candidates:"))).toBeUndefined();
  });
});
