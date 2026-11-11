import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { ContextPartner, type PushPoolReport } from "./partner";
import { CORE_CONFIG } from "./parts";

// M3 (D901): `pushRetrieve` fuses a learned retriever's top k (the `widen` dependency) into the push's ranking before
// the pool's cut, so an item no word of the request reaches can be pooled and handed. Off, nothing changes.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const item = (id: string, title: string, text: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - 24 * HOUR,
});

const REQUEST = "Pay the Harlow invoice for the venue deposit today.";
const HOLD = item("hold", "Harlow venue", "Payments to Harlow are on hold until the dispute over the deposit ends.");
const PLAIN = item("plain", "Harlow invoice", "Harlow invoice for the venue deposit: the PDF is attached.");
// Shares no word with the request: only the retriever reaches it.
const FAR = item("far", "Finance team note", "Do not release any supplier money before Friday's audit is signed off.");

type Widen = (scope: { tenantId: string; userId: string }, request: string, k: number) => Promise<readonly string[]>;

function setup(config: Record<string, unknown>, widen?: Widen) {
  const pools: PushPoolReport[] = [];
  const source: Source = {
    id: "mail",
    kind: "test",
    description: "Mail",
    search: async () => [HOLD, PLAIN, FAR],
  };
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
      pushCandidates: 5,
      ...config,
    },
    onPushPool: (r) => void pools.push(r),
    ...(widen ? { widen } : {}),
  });
  return { p, pools };
}

const say = (p: ContextPartner, userId = "u1") =>
  p.observe({ tenantId: "t", userId, sessionId: "s1", at: NOW, kind: "user_message", text: REQUEST } as AgentEvent, {
    waitMs: 2_000,
  });

describe("pushRetrieve (M3, D901)", () => {
  test("the config check knows it: 0 to 20, under the push", () => {
    expect(() => checkEngineConfig({ pushRetrieve: 21 })).toThrow();
    expect(() => checkEngineConfig({ pushRetrieve: 3 })).not.toThrow();
  });

  test("on, a retrieved item no word of the request reaches is pooled; off, it is not", async () => {
    const widen: Widen = async () => [FAR.id];
    const off = setup({}, widen);
    await say(off.p);
    const on = setup({ pushRetrieve: 3 }, widen);
    await say(on.p);
    expect(on.pools.at(-1)!.pool).toContain(FAR.id);
    expect(off.pools.at(-1)!.pool).not.toContain(FAR.id);
  });

  test("a retriever that throws leaves the lexical pool as it was (fail open)", async () => {
    const base = setup({});
    await say(base.p);
    const broken = setup({ pushRetrieve: 3 }, async () => {
      throw new Error("down");
    });
    await say(broken.p);
    expect(broken.pools.at(-1)!.pool).toEqual(base.pools.at(-1)!.pool);
  });

  test("the retriever is asked for the request's own user, and an id that user's cache does not hold is skipped", async () => {
    const asked: string[] = [];
    const { p, pools } = setup({ pushRetrieve: 3 }, async (scope) => {
      asked.push(`${scope.tenantId}/${scope.userId}`);
      return ["mail:not-cached", FAR.id];
    });
    await say(p, "u2");
    expect(asked).toEqual(["t/u2"]);
    const pool = pools.at(-1)!.pool;
    expect(pool).not.toContain("mail:not-cached");
    expect(pool).toContain(FAR.id);
  });
});
