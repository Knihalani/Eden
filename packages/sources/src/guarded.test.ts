import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { SourceFanout } from "./guarded";
import { PlannedSource, QueryPlanner } from "./planner";
import type { SearchQuery, Source } from "./source";

const scope = { tenantId: "t", userId: "u" };
const query = (text = "renewal"): SearchQuery => ({ scope, text, entities: ["Dana Lee"], limit: 5 });
const item = (text: string): ContextItem => ({ id: "s:1", sourceId: "s", ref: "1", title: "t", text });

function source(behave: (call: number, signal: AbortSignal) => Promise<ContextItem[]>): Source & { calls: number } {
  const s = {
    id: "s",
    kind: "test",
    description: "",
    calls: 0,
    search: (_q: SearchQuery, signal: AbortSignal) => behave(++s.calls, signal),
  };
  return s;
}
const redactAll = (items: ContextItem[]) =>
  items.map((i) => ({ ...i, text: i.text.replace(/secret\S*/g, "[REDACTED]") }));

describe("SourceFanout", () => {
  test("results are sanitized before they are returned or cached, and a fresh repeat is a cache hit", async () => {
    const src = source(async () => [item("token secretXYZ here")]);
    const f = new SourceFanout({ sanitize: redactAll });
    const [first] = await f.search([src], query(), { timeoutMs: 1_000 });
    expect(first).toMatchObject({ status: "ok" });
    expect(first!.items[0]!.text).toBe("token [REDACTED] here");
    const [second] = await f.search([src], query(), { timeoutMs: 1_000 });
    expect(second!.status).toBe("cached");
    expect(second!.items[0]!.text).toBe("token [REDACTED] here");
    expect(src.calls).toBe(1);
  });

  test("a stale result is served when the source times out", async () => {
    let now = 0;
    const src = source(async (call, signal) => {
      if (call === 1) return [item("v1")];
      return new Promise<ContextItem[]>((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    });
    const f = new SourceFanout({ sanitize: (x) => x, freshMs: 10, staleMs: 10_000, now: () => now });
    await f.search([src], query(), { timeoutMs: 1_000 });
    now = 100; // past fresh, within stale
    const [out] = await f.search([src], query(), { timeoutMs: 30 });
    expect(out).toMatchObject({ status: "stale", items: [expect.objectContaining({ text: "v1" })] });
  });

  test("identical concurrent searches share one call", async () => {
    const src = source(async () => {
      await Bun.sleep(20);
      return [item("x")];
    });
    const f = new SourceFanout({ sanitize: (x) => x, cacheBytes: 0 });
    const outs = await Promise.all([1, 2, 3].map(() => f.search([src], query(), { timeoutMs: 1_000 })));
    expect(outs.map((o) => o[0]!.status)).toEqual(["ok", "ok", "ok"]);
    expect(src.calls).toBe(1);
  });

  test("a failing source opens its breaker and is then skipped without a call", async () => {
    const src = source(async () => {
      throw new Error("500 upstream");
    });
    const f = new SourceFanout({ sanitize: (x) => x, cacheBytes: 0, breaker: { minCalls: 3, failureRate: 0.5 } });
    for (let i = 0; i < 3; i++) await f.search([src], query(`q${i}`), { timeoutMs: 1_000 });
    const [out] = await f.search([src], query("next"), { timeoutMs: 1_000 });
    expect(out!.status).toBe("open");
    expect(src.calls).toBe(3);
  });

  test("a caller giving up (session end, forget) is no evidence against the source (branch review)", async () => {
    const src = source(
      (call, signal) =>
        new Promise((resolve, reject) => {
          if (call > 3) resolve([item("ok")]);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const f = new SourceFanout({ sanitize: (x) => x, cacheBytes: 0, breaker: { minCalls: 3, failureRate: 0.5 } });
    for (let i = 0; i < 3; i++) {
      const ac = new AbortController();
      const pending = f.search([src], query(`q${i}`), { timeoutMs: 5_000, signal: ac.signal });
      ac.abort(new Error("session ended"));
      await pending;
    }
    const [out] = await f.search([src], query("next"), { timeoutMs: 1_000 });
    expect(out!.status).toBe("ok"); // Not "open": three abandoned calls did not trip the breaker.
    expect(src.calls).toBe(4);
  });

  test("a 429 with Retry-After pushes the rate limit back", async () => {
    const src = source(async () => {
      throw new Error("429 Too Many Requests, retry after 60");
    });
    const f = new SourceFanout({ sanitize: (x) => x, cacheBytes: 0, breaker: { minCalls: 100 } });
    await f.search([src], query("a"), { timeoutMs: 1_000 });
    const [out] = await f.search([src], query("b"), { timeoutMs: 1_000 });
    expect(out!.status).toBe("limited");
    expect(src.calls).toBe(1);
  });

  test("forget drops a user's cached results", async () => {
    const src = source(async () => [item("x")]);
    const f = new SourceFanout({ sanitize: (x) => x });
    await f.search([src], query(), { timeoutMs: 1_000 });
    f.forget(scope);
    await f.search([src], query(), { timeoutMs: 1_000 });
    expect(src.calls).toBe(2);
  });

  test("users never share cached results", async () => {
    const src = source(async () => [item("alice's")]);
    const f = new SourceFanout({ sanitize: (x) => x });
    await f.search([src], query(), { timeoutMs: 1_000 });
    const bob = { ...query(), scope: { tenantId: "t", userId: "bob" } };
    const [out] = await f.search([src], bob, { timeoutMs: 1_000 });
    expect(out!.status).toBe("ok");
    expect(src.calls).toBe(2);
  });
});

describe("SourceFanout.planCalls (the query planner's calls)", () => {
  /** A connector that matches the whole query as one substring. */
  const substring = () => {
    const log: string[] = [];
    const docs = [item("Dana Lee asked about the secretPLAN renewal"), { ...item("Globex invoice"), id: "s:2" }];
    const s: Source & { log: string[] } = {
      id: "s",
      kind: "test",
      description: "",
      log,
      search: async (q) => (log.push(q.text), docs.filter((d) => d.text.toLowerCase().includes(q.text.toLowerCase()))),
    };
    return s;
  };
  // The cue's terms ("dana lee") are the planner's first shape, and match.
  const cue = (entities = ["Dana Lee"], who = scope): SearchQuery => ({
    scope: who,
    text: "dana lee",
    entities,
    limit: 5,
  });
  const planned = (f: SourceFanout, src: Source, who = scope) =>
    new PlannedSource(src, new QueryPlanner({ seed: 1, epsilon: 0 }), () => f.permit(who, src.id), f.planCalls(src));
  const shapeQuery = (who = scope, text = "dana lee"): SearchQuery => ({ scope: who, text, entities: [], limit: 5 });
  const signal = new AbortController().signal;

  test("a shape's query answered recently is served from the cache: no call, no rate token", async () => {
    const src = substring();
    // One token: the first lookup's admission. The second is admitted, then its shape is answered from the cache.
    const f = new SourceFanout({ sanitize: redactAll, burst: 2, ratePerSec: 0.001, now: () => 0 });
    // Two lookups that differ (so the whole-lookup cache misses) but send the same shape query.
    const [a] = await f.search([planned(f, src)], cue(["Dana Lee"]), { timeoutMs: 1_000 });
    const [b] = await f.search([planned(f, src)], cue(["Dana"]), { timeoutMs: 1_000 });
    expect(a!.status).toBe("ok");
    expect(b!.status).toBe("ok");
    expect(b!.items.map((i) => i.text)).toEqual(a!.items.map((i) => i.text));
    expect(src.log).toEqual(["dana lee"]);
  });

  test("planned calls are sanitized once, before they are held, and the lookup is not gated twice", async () => {
    const src = substring();
    let gated = 0;
    const f = new SourceFanout({ sanitize: (items) => ((gated += items.length), redactAll(items)) });
    const [out] = await f.search([planned(f, src)], cue(), { timeoutMs: 1_000 });
    expect(out!.items[0]!.text).toBe("Dana Lee asked about the [REDACTED] renewal");
    expect(gated).toBe(1);
    expect(f.planCalls(src).cached(shapeQuery())![0]!.text).toContain("[REDACTED]");
  });

  test("a planned source with calls from another fan-out is still sanitized", async () => {
    const src = substring();
    const f = new SourceFanout({ sanitize: redactAll });
    const other = new SourceFanout({ sanitize: (x) => x });
    const foreign = new PlannedSource(src, new QueryPlanner({ seed: 1 }), undefined, other.planCalls(src));
    const [out] = await f.search([foreign], cue(), { timeoutMs: 1_000 });
    expect(out!.items[0]!.text).toContain("[REDACTED]");
  });

  test("a later shape answered recently takes no call and no rate token", async () => {
    const src = substring();
    const f = new SourceFanout({ sanitize: (x) => x });
    // Every cascade shape for this cue is already held: per entity ("Dana Lee") and entity plus term.
    for (const text of ["Dana Lee", "Dana Lee status"]) await f.planCalls(src).call(shapeQuery(scope, text), signal);
    const before = src.log.length;
    let permits = 0;
    const planner = new QueryPlanner({ seed: 1, epsilon: 0, cascadeMin: 0 });
    const p = new PlannedSource(src, planner, () => (permits++, true), f.planCalls(src));
    // The cue's terms ("status" alone) find nothing on this connector, so the cascade runs.
    const [out] = await f.search([p], { ...cue(), text: "status" }, { timeoutMs: 1_000 });
    expect(out!.status).toBe("ok");
    expect(p.last!.shapes).toHaveLength(2);
    expect(src.log.slice(before)).toEqual(["status"]);
    expect(permits).toBe(0);
  });

  test("a planner call still running when its user is forgotten holds nothing afterwards", async () => {
    for (const abort of [true, false]) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // A connector that ignores the abort and answers late, as a slow server may.
      const src: Source = { id: "s", kind: "t", description: "", search: async () => (await gate, [item("Dana Lee")]) };
      const f = new SourceFanout({ sanitize: (x) => x });
      const ac = new AbortController();
      const p = new PlannedSource(src, new QueryPlanner({ seed: 1 }), undefined, f.planCalls(src));
      const out = f.search([p], cue(), { timeoutMs: 5_000, signal: ac.signal });
      await Bun.sleep(5);
      if (abort) ac.abort();
      f.forget(scope);
      release();
      await out;
      await Bun.sleep(5);
      expect(f.planCalls(src).cached(shapeQuery())).toBeUndefined();
    }
  });

  test("a connector's recent call latency is known per user after enough calls, and forgotten with them", async () => {
    const src = substring();
    let t = 0;
    const f = new SourceFanout({ sanitize: (x) => x, cacheBytes: 0, now: () => t });
    const bob = { tenantId: "t", userId: "bob" };
    // The lookup that admits the source makes its state; planner calls then record into it.
    await f.search([planned(f, src)], cue(), { timeoutMs: 1_000 });
    const calls = f.planCalls(src);
    for (let i = 0; i < 3; i++) await calls.call(shapeQuery(scope, `q${i}`), signal);
    // The lookup's own call plus three: too few to trust a quantile yet.
    expect(calls.expectMs!(shapeQuery(), 0.9)).toBe(0);
    await calls.call(shapeQuery(scope, "q3"), signal);
    expect(calls.expectMs!(shapeQuery(), 0.9)).toBeGreaterThan(0);
    expect(calls.expectMs!(shapeQuery(bob), 0.9)).toBe(0);
    f.forget(scope);
    expect(calls.expectMs!(shapeQuery(), 0.9)).toBe(0);
  });

  test("a planner call still running when its user is forgotten brings back no state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Source = { id: "s", kind: "t", description: "", search: async () => (await gate, [item("x")]) };
    const f = new SourceFanout({ sanitize: (x) => x });
    await f.search([slow], { ...cue(), text: "warm" }, { timeoutMs: 1_000 }).catch(() => {});
    const pending = f.planCalls(slow).call(shapeQuery(), signal);
    f.forget(scope);
    release();
    await pending;
    expect((f as unknown as { per: Map<string, unknown> }).per.size).toBe(0);
  });

  test("a call cut off by its timeout counts with its time so far; one abandoned otherwise does not", async () => {
    const hang: Source = {
      id: "s",
      kind: "t",
      description: "",
      search: (_q, sig) => new Promise((_, reject) => sig.addEventListener("abort", () => reject(sig.reason))),
    };
    const f = new SourceFanout({ sanitize: (x) => x, cacheBytes: 0 });
    const calls = f.planCalls(hang);
    // Admit the source (its state exists), then abandon five calls by session end and five by timeout.
    await f.search([hang], { ...cue(), text: "warm" }, { timeoutMs: 5 });
    for (let i = 0; i < 5; i++) {
      const ac = new AbortController();
      const p = calls.call(shapeQuery(scope, `ended ${i}`), ac.signal).catch(() => {});
      // Ended after 10 ms: were these recorded, the history would read about 10 ms.
      await Bun.sleep(10);
      ac.abort();
      await p;
    }
    expect(calls.expectMs!(shapeQuery(), 0.5)).toBe(0);
    for (let i = 0; i < 5; i++) {
      await calls.call(shapeQuery(scope, `slow ${i}`), AbortSignal.timeout(20)).catch(() => {});
    }
    expect(calls.expectMs!(shapeQuery(), 0.5)).toBeGreaterThanOrEqual(15);
  });

  test("planned results are per user and dropped by forget", async () => {
    const src = substring();
    const f = new SourceFanout({ sanitize: (x) => x });
    const bob = { tenantId: "t", userId: "bob" };
    await f.search([planned(f, src)], cue(), { timeoutMs: 1_000 });
    expect(f.planCalls(src).cached(shapeQuery())).toBeDefined();
    expect(f.planCalls(src).cached(shapeQuery(bob))).toBeUndefined();
    f.forget(scope, "s");
    expect(f.planCalls(src).cached(shapeQuery())).toBeUndefined();
  });
});
