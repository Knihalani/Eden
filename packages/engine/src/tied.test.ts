import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";

/**
 * `judgeTied`: the judge is asked only when a candidate is tied to the request (a probe's find, a day it names, two of
 * its words, or one word few of the user's items hold). The user's mail is 40 short replies that all say "perfect",
 * so "perfect" is common to them; one also names Zanzibar, a word only it holds.
 */
describe("judgeTied", () => {
  const scope = { tenantId: "t", userId: "u" };
  const at = Date.parse("2026-10-27T09:00:00Z");
  const docs = Array.from({ length: 40 }, (_, k) => ({
    ref: `m${k}`,
    title: `Reply ${k}`,
    text: k === 7 ? "Perfect, the Zanzibar trip is booked." : `Perfect, see you then. Note ${k}.`,
  }));
  const engine = (config: Record<string, unknown>, model: FakeModel) => {
    // The user's mail as Eden has already read it (the cache earlier lookups leave).
    const cache = new ItemCache();
    cache.put(
      scope,
      docs.map((d) => ({ id: `gmail:${d.ref}`, sourceId: "gmail", ...d })),
      at,
    );
    return new ContextPartner({
      sources: async () => [new StaticSource("gmail", "Mail", docs)],
      sourceMap: new SourceMap(),
      cache,
      budget: new Budget(),
      model,
      now: () => at,
      // Nothing is sure on its words alone: every candidate goes to the judge unless the rule under test stops it.
      config: { confidentScore: 99, ...config },
    });
  };
  const say = async (p: ContextPartner, text: string, who = scope, sessionId = "s") => {
    const r = await p.observe({ ...who, sessionId, at, kind: "user_message", text } as AgentEvent, { waitMs: 1_000 });
    return [...(r.injection ? [r.injection] : []), ...p.takePending({ ...who, sessionId })].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
  };

  test("candidates sharing only a word common to the user's items are not judged; off, they are", async () => {
    const off = new FakeModel(() => '{"pick": []}');
    await say(engine({}, off), "that sounds perfect");
    expect(off.calls.length).toBe(1);
    const on = new FakeModel(() => '{"pick": [0]}');
    expect(await say(engine({ judgeTied: true }, on), "that sounds perfect")).toEqual([]);
    expect(on.calls.length).toBe(0);
  });

  test("a candidate holding a word few of the user's items hold is judged and delivered", async () => {
    const model = new FakeModel(() => '{"pick": [0]}');
    const got = await say(engine({ judgeTied: true }, model), "is the zanzibar plan perfect");
    expect(model.calls.length).toBe(1);
    expect(got).toEqual(["gmail:m7"]);
  });

  test("rarity is the user's own: another user's mail does not make a word common to them", async () => {
    const model = new FakeModel(() => '{"pick": []}');
    const p = engine({ judgeTied: true }, model);
    // User v's cache holds only what this lookup read: too few items for any word to be known as common to them, so
    // the candidates are tied and judged.
    await say(p, "that sounds perfect", { tenantId: "t", userId: "v" }, "sv");
    expect(model.calls.length).toBe(1);
  });
});
