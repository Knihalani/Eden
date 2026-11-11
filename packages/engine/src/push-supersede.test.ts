import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { checkEngineConfig } from "./config-check";
import { ContextPartner, type PushPoolReport } from "./partner";
import { CORE_CONFIG } from "./parts";

// M3 (D908 rule 1): `pushSupersede` hands a newer pooled item in place of a handed one a pair model says it replaces.
// Off (0) or unwired, nothing changes; a model that throws or answers null replaces nothing.

const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const item = (id: string, title: string, text: string, ageH: number): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
});

const REQUEST = "Pay the Harlow invoice for the venue deposit today.";
// Both constraint-worded and naming the request's anchor (Harlow); the newer one replaces the older.
const OLD = item("old", "Harlow venue", "Payments to Harlow are on hold until the deposit dispute ends.", 48);
const NEW = item("new", "Harlow venue update", "The Harlow deposit dispute is settled: payments to Harlow resume.", 2);

type Dep = (scope: { tenantId: string; userId: string }, older: ContextItem, newer: ContextItem) => number | null;

function setup(config: Record<string, unknown>, dep?: Dep) {
  const pools: PushPoolReport[] = [];
  const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => [OLD, NEW] };
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
    ...(dep ? { supersede: dep } : {}),
  });
  return { p, pools };
}

const say = (p: ContextPartner) =>
  p.observe(
    { tenantId: "t", userId: "u1", sessionId: "s1", at: NOW, kind: "user_message", text: REQUEST } as AgentEvent,
    {
      waitMs: 2_000,
    },
  );

describe("pushSupersede (M3, D908 rule 1)", () => {
  test("the config check knows it: a probability threshold", () => {
    expect(() => checkEngineConfig({ pushSupersede: 2 })).toThrow();
    expect(() => checkEngineConfig({ pushSupersede: 0.5 })).not.toThrow();
  });

  test("off, the pair model is not read and both versions are handed", async () => {
    let calls = 0;
    const { p, pools } = setup({}, () => (calls++, 1));
    await say(p);
    expect(calls).toBe(0);
    expect(new Set(pools.at(-1)!.handed)).toEqual(new Set([OLD.id, NEW.id]));
  });

  test("on, the replaced older version is not handed; the newer one is, once; only newer items are asked", async () => {
    const asked: [string, string][] = [];
    const { p, pools } = setup({ pushSupersede: 0.5 }, (_, o, n) => (asked.push([o.id, n.id]), 0.9));
    await say(p);
    expect(pools.at(-1)!.handed).toEqual([NEW.id]);
    expect(asked.every(([o, n]) => o === OLD.id && n === NEW.id)).toBe(true);
  });

  test("under the threshold, or with a model that throws or answers null, nothing is replaced (fail open)", async () => {
    for (const dep of [
      () => 0.2,
      () => null,
      () => {
        throw new Error("down");
      },
    ] as Dep[]) {
      const { p, pools } = setup({ pushSupersede: 0.5 }, dep);
      await say(p);
      expect(new Set(pools.at(-1)!.handed)).toEqual(new Set([OLD.id, NEW.id]));
    }
  });
});
