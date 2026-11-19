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
import { TurnGate } from "./turn-gate";

// `pushAsk` (D1985): a turn that asks starts an opened push when nothing started one — the questions the turn
// gate stays silent on, and the ones whose rule start it vetoed. The candidates' own gate decides whether
// anything goes, so silence stays the default.

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
  // Shares the question's words and is constraint-worded: it opens the candidates' gate.
  item("wifi", "Wifi", "The wifi password must not be shared: keep it off messages going out."),
  item("net", "Broadband", "Your broadband plan renews in March."),
];

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
      .map((t) => `{"i":${n.get(t)},"on":"${t}","hits":"the question","act":true}`);
    return `{"items":[${entries.join(",")}]}`;
  });

/** A gate stand-in reading every turn the same kind (the shipped weights stay the default). */
const fakeGate = (kind: string, needs = false) =>
  ({
    read: () => ({ needs, kind, logit: -1 }),
  }) as unknown as TurnGate;

function setup(
  config: Record<string, unknown>,
  model: Model | null,
  pools: PushPoolReport[] = [],
  items = ITEMS,
  gate?: TurnGate | null,
) {
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
    ...(gate !== undefined ? { turnGate: gate } : {}),
    onPushPool: (r) => pools.push(r),
  });
}

const ref = { tenantId: "t", userId: "u1", sessionId: "s1" };
const gated = { pushOpen: true, pushIndirect: true, pushGate: true, pushCandidates: 5 };
const QUESTION = "What's the wifi password?";
const STATEMENT = "The wifi password was changed last month.";

async function handed(p: ContextPartner, text = QUESTION, at = ref): Promise<string[]> {
  await p.observe({ ...at, at: NOW, kind: "user_message", text } as AgentEvent, { waitMs: 2_000 });
  const got = p.takePending(at).find((x) => x.reason.startsWith("candidates:"));
  return got ? got.citations.map((c) => c.itemId) : [];
}

describe("pushAsk (D1985): a turn that asks starts an opened push", () => {
  test("on in the default, out with the part `ask`", () => {
    expect(DEFAULT_CONFIG.pushAsk).toBe(true);
    expect(CORE_CONFIG.pushAsk).toBe(false);
    expect(() => checkEngineConfig({ pushAsk: true })).not.toThrow();
  });

  test("off: a question the rule and gate leave alone starts no push", async () => {
    const pools: PushPoolReport[] = [];
    await handed(setup(gated, says(["Wifi"]), pools));
    expect(pools.length).toBe(0);
  });

  test("on: it starts one and the candidates' gate decides", async () => {
    const pools: PushPoolReport[] = [];
    const ids = await handed(setup({ ...gated, pushAsk: true }, says(["Wifi"]), pools));
    expect(pools.length).toBeGreaterThan(0);
    expect(ids).toEqual(["mail:wifi"]);
  });

  test("a pool with nothing constraint-like stays silent: the start adds no false fire", async () => {
    const plain = [item("receipt", "Wifi receipt", "Your wifi receipt for September."), ITEMS[1]!];
    const pools: PushPoolReport[] = [];
    const ids = await handed(setup({ ...gated, pushAsk: true }, says([]), pools, plain));
    expect(pools.length).toBeGreaterThan(0);
    expect(ids).toEqual([]);
  });

  test("a statement, a draft and chatter start none", async () => {
    for (const text of [STATEMENT]) {
      const pools: PushPoolReport[] = [];
      await handed(setup({ ...gated, pushAsk: true }, says(["Wifi"]), pools), text);
      expect(pools.length).toBe(0);
    }
    const p = setup({ ...gated, pushAsk: true }, says(["Wifi"]));
    const r = await p.observe({ ...ref, at: NOW, kind: "user_message", text: QUESTION, draft: true } as AgentEvent);
    expect(r.injection ?? null).toBeNull();
  });

  test("the gate's chatter reading holds back a question mark", async () => {
    const pools: PushPoolReport[] = [];
    await handed(setup({ ...gated, pushAsk: true }, says(["Wifi"]), pools, ITEMS, fakeGate("chatter")), "you ok?");
    expect(pools.length).toBe(0);
  });

  test("the gate's ask reading starts one where the shape lacks a mark", async () => {
    const pools: PushPoolReport[] = [];
    const ids = await handed(
      setup({ ...gated, pushAsk: true }, says(["Wifi"]), pools, ITEMS, fakeGate("ask")),
      "the wifi password",
    );
    expect(pools.length).toBeGreaterThan(0);
    expect(ids).toEqual(["mail:wifi"]);
  });

  test("with no gate the question's shape alone decides (fail open)", async () => {
    const pools: PushPoolReport[] = [];
    const ids = await handed(setup({ ...gated, pushAsk: true }, says(["Wifi"]), pools, ITEMS, null), QUESTION);
    expect(ids).toEqual(["mail:wifi"]);
    const quiet: PushPoolReport[] = [];
    await handed(setup({ ...gated, pushAsk: true }, says(["Wifi"]), quiet, ITEMS, null), STATEMENT);
    expect(quiet.length).toBe(0);
  });
});
