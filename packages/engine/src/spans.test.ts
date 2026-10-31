import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import type { Span } from "./trace";

// The span sink (`PartnerDeps.onSpan`) times the engine's phases for lab timelines (pi-ab.ts). It must carry names
// and counts only, attribute each span to its own session, and change nothing the engine decides.
describe("spans: the engine's timed phases", () => {
  const at = Date.parse("2026-10-27T09:00:00Z");
  const secret = "Hall B, parents only";
  const calendar = () =>
    new StaticSource("calendar", "Calendar", [
      { ref: "pe", title: "Parents' evening", text: secret, meta: { start: "2026-10-29T18:30:00Z" } },
    ]);
  const ask = "Set up dinner with Jamie Fox on Thursday 29 October at 19:00";
  const run = async (onSpan?: (s: Span) => void, sessionId = "s", userId = "u") => {
    let calls = 0;
    const source = calendar();
    const counted: Source = {
      id: source.id,
      kind: "test",
      description: source.description,
      listsByTime: source.listsByTime,
      search: (q) => (calls++, source.search(q)),
    };
    const p = new ContextPartner({
      sources: async () => [counted],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => at,
      config: { probes: true },
      ...(onSpan ? { onSpan } : {}),
    });
    const scope = { tenantId: "t", userId, sessionId };
    const r = await p.observe({ ...scope, at, kind: "user_message", text: ask } as AgentEvent, { waitMs: 1_000 });
    const got = [...(r.injection ? [r.injection] : []), ...p.takePending(scope)].flatMap((i) =>
      i.citations.map((c) => c.itemId),
    );
    const answer = await p.ask({ ...scope, question: "When is the parents' evening?" });
    return { got, calls, answer: answer.answer };
  };

  test("a lookup reports its slow path, its search and its probes, in order, with calls and no content", async () => {
    const spans: Span[] = [];
    await run((s) => spans.push(s));
    const names = spans.map((s) => s.name);
    expect(names).toContain("slow");
    expect(names).toContain("search");
    expect(names).toContain("probe:day");
    expect(names).toContain("ask");
    for (const s of spans) {
      expect(s.sessionId).toBe("s");
      expect(s.end).toBeGreaterThanOrEqual(s.start);
      // Names and numbers only: no request text, no item text.
      expect(JSON.stringify(s)).not.toContain("Parents");
      expect(JSON.stringify(s)).not.toContain(secret);
      expect(JSON.stringify(s)).not.toContain("Jamie");
    }
    const search = spans.find((s) => s.name === "search")!;
    expect(search.calls).toBe(1);
    // The slow path holds its search: it starts no later and ends no earlier.
    const slow = spans.find((s) => s.name === "slow")!;
    expect(slow.start).toBeLessThanOrEqual(search.start);
    expect(slow.end).toBeGreaterThanOrEqual(search.end);
  });

  test("listening changes nothing the engine does", async () => {
    const quiet = await run();
    const heard = await run(() => {});
    expect(heard).toEqual(quiet);
  });

  test("a sink that throws never breaks a lookup", async () => {
    const quiet = await run();
    const broken = await run(() => {
      throw new Error("sink down");
    });
    expect(broken).toEqual(quiet);
  });

  test("each session's spans carry its own session id (isolation)", async () => {
    const spans: Span[] = [];
    await run((s) => spans.push(s), "a", "u1");
    await run((s) => spans.push(s), "b", "u2");
    expect(new Set(spans.map((s) => s.sessionId))).toEqual(new Set(["a", "b"]));
  });
});
