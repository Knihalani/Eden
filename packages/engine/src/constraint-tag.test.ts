import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { ContextPartner, type PushPoolReport, type TagReader } from "./partner";
import { CORE_CONFIG } from "./parts";

// M3 (D908): `constraintTag` vetoes the push gate's constraint test with a small item tagger's reading: an item the
// tagger reads as an all-clear is not constraint-like. Off (0) or unwired, nothing changes; a tagger that throws
// vetoes nothing.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (id: string, title: string, text: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - 24 * 3_600_000,
});

const REQUEST = "Pay the Harlow invoice for the venue deposit today.";
// Constraint-worded (`constraintLike` passes it): payments on hold.
const HOLD = item("hold", "Harlow venue", "Payments to Harlow are on hold until the dispute over the deposit ends.");
const PLAIN = item("plain", "Harlow invoice", "Harlow invoice for the venue deposit: the PDF is attached.");

type Tag = (scope: { tenantId: string; userId: string }, it: ContextItem) => number | null;

function setup(config: Record<string, unknown>, tag?: Tag | TagReader | null) {
  const pools: PushPoolReport[] = [];
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => [HOLD, PLAIN] };
  const p = new ContextPartner({
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
      pushCandidates: 5,
      ...config,
    },
    onPushPool: (r) => void pools.push(r),
    ...(tag === undefined ? {} : { constraintTag: typeof tag === "function" ? { read: tag } : tag }),
  });
  return { p, pools };
}

const say = (p: ContextPartner, userId = "u1") =>
  p.observe({ tenantId: "t", userId, sessionId: "s1", at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, {
    waitMs: 2_000,
  });

const likeOf = (r: PushPoolReport, id: string) => r.constraintLike[r.pool.indexOf(id)];

describe("constraintTag (M3, D908)", () => {
  test("the config check knows it: a probability threshold", () => {
    expect(() => checkEngineConfig({ constraintTag: 1.5 })).toThrow();
    expect(() => checkEngineConfig({ constraintTag: 0.4 })).not.toThrow();
  });

  test("off, the tagger is not read and the constraint test stands", async () => {
    let calls = 0;
    const { p, pools } = setup({}, () => (calls++, 0));
    await say(p);
    expect(calls).toBe(0);
    expect(likeOf(pools.at(-1)!, HOLD.id)).toBe(true);
  });

  test("on, a constraint-worded item the tagger reads as an all-clear is vetoed; one it reads as a constraint stays", async () => {
    const low = setup({ constraintTag: 0.5 }, () => 0.1);
    await say(low.p);
    expect(likeOf(low.pools.at(-1)!, HOLD.id)).toBe(false);
    const high = setup({ constraintTag: 0.5 }, () => 0.9);
    await say(high.p);
    expect(likeOf(high.pools.at(-1)!, HOLD.id)).toBe(true);
  });

  test("the veto never makes an item constraint-like that the existing test rejects", async () => {
    const { p, pools } = setup({ constraintTag: 0.5 }, () => 1);
    await say(p);
    expect(likeOf(pools.at(-1)!, PLAIN.id)).toBe(false);
  });

  test("a tagger that throws or answers null vetoes nothing (fail open); it is asked for the request's user", async () => {
    const asked: string[] = [];
    const broken = setup({ constraintTag: 0.5 }, (scope) => {
      asked.push(scope.userId);
      throw new Error("down");
    });
    await say(broken.p, "u7");
    expect(likeOf(broken.pools.at(-1)!, HOLD.id)).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((u) => u === "u7")).toBe(true);
    const silent = setup({ constraintTag: 0.5 }, () => null);
    await say(silent.p);
    expect(likeOf(silent.pools.at(-1)!, HOLD.id)).toBe(true);
  });

  test("stored items go to the tagger's background ingest, per user; a user's forget drops their readings", async () => {
    const ingested: string[] = [];
    const forgot: string[] = [];
    const reader: TagReader = {
      read: () => 0.9,
      ingest: (scope, items) => void ingested.push(...items.map((i) => `${scope.userId}:${i.id}`)),
      forget: (scope, ids) => void forgot.push(`${scope.userId}:${ids ? ids.join(",") : "*"}`),
    };
    const { p } = setup({ constraintTag: 0.5 }, reader);
    await say(p, "u1");
    expect(ingested).toContain(`u1:${HOLD.id}`);
    expect(ingested.every((x) => x.startsWith("u1:"))).toBe(true);
    p.forget({ tenantId: "t", userId: "u1" });
    expect(forgot).toContain("u1:*");
  });

  test("null turns the veto off; absent, the partner reads the shipped tagger itself", async () => {
    const off = setup({ constraintTag: 0.5 }, null);
    await say(off.p);
    expect(likeOf(off.pools.at(-1)!, HOLD.id)).toBe(true);
    const own = setup({ constraintTag: 0.999 });
    await say(own.p);
    // At a threshold no reading clears, the shipped tagger vetoes the constraint-worded item.
    expect(likeOf(own.pools.at(-1)!, HOLD.id)).toBe(false);
  });
});
