import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner, StaticSource, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner, type PartnerDeps } from "./partner";
import { SPAN_NAMES, SpanStats, Tracer, type Span } from "./spans";
import type { Trace } from "./trace";

let clock = 1_700_000_000_000;
const scope = { tenantId: "t1", userId: "u1" };
const ev = (sessionId: string, e: Record<string, unknown>) =>
  ({ ...scope, sessionId, at: clock++, ...e }) as AgentEvent;

/** Words that appear only in the request and the items: no span may carry them (D19). */
const SECRETISH = ["Zorblax", "quuxfrobnicate", "deal-9", "evt-1"];

const sources = (): Source[] => [
  new StaticSource("crm", "Deals and accounts", [
    { ref: "deal-9", title: "Zorblax renewal", text: "Zorblax renewal due 2026-11-30, Dana Lee is the champion" },
    { ref: "acct-2", title: "Initech account", text: "Initech pays annually, contact Bill Lumbergh" },
  ]),
  new StaticSource("calendar", "The user's calendar", [
    { ref: "evt-1", title: "Call with Dana Lee", text: "Thursday 3pm, Zorblax quuxfrobnicate check-in" },
  ]),
];

function partner(extra: Partial<PartnerDeps> = {}) {
  const traces: Trace[] = [];
  const p = new ContextPartner({
    sources: async () => sources(),
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    onTrace: (t) => traces.push(t),
    ...extra,
  });
  return { p, traces };
}

/** One session's two events: a lookup through the slow path, then the same need from the cache. */
async function play(p: ContextPartner, sessionId = "s1") {
  const a = await p.observe(
    ev(sessionId, { kind: "user_message", text: "Prep me for Dana Lee and the Zorblax renewal" }),
    {
      waitMs: 2_000,
    },
  );
  const b = await p.observe(
    ev(sessionId, { kind: "user_message", text: "Zorblax renewal with Dana Lee: anything new?" }),
    {
      waitMs: 2_000,
    },
  );
  return [a.injection?.citations.map((c) => c.itemId) ?? [], b.injection?.citations.map((c) => c.itemId) ?? []];
}

const H = {
  probes: true,
  compactInjection: true,
  probeShare: true,
  probeFresh: true,
  probeYield: true,
  densePacket: true,
  groundConflict: true,
  judgeTied: true,
};

describe("spans", () => {
  test("off by default: no tracer, no stats, and the same deliveries as with spans on", async () => {
    const off = partner({ config: H });
    expect((off.p as unknown as { spans: unknown }).spans).toBeNull();
    const spans: Span[] = [];
    const on = partner({ config: H, onSpan: (s) => spans.push(s) });
    const a = await play(off.p);
    const b = await play(on.p);
    expect(b).toEqual(a);
    expect(a[0]!.length).toBeGreaterThan(0);
    expect(off.p.spanStats()).toEqual([]);
    expect(spans.length).toBeGreaterThan(10);
    // Same decisions and calls, traced or not.
    const strip = (ts: Trace[]) => ts.map((t) => ({ ...t, latencyMs: 0 }));
    expect(strip(on.traces)).toEqual(strip(off.traces));
  });

  test("every phase is a well-formed span in one tree per event, with named phases only", async () => {
    const spans: Span[] = [];
    const { p } = partner({
      config: H,
      onSpan: (s) => spans.push(s),
      planner: new QueryPlanner({ seed: 1 }),
    });
    await play(p);
    const byId = new Map(spans.map((s) => [s.id, s]));
    expect(byId.size).toBe(spans.length); // Ids are unique.
    const known = new Set<string>(SPAN_NAMES);
    for (const s of spans) {
      expect(known.has(s.name) || (s.name.startsWith("probe.") && known.has("probe.*"))).toBe(true);
      expect(s.endMs).toBeGreaterThanOrEqual(s.startMs);
      expect(s.cpuUs).toBeGreaterThanOrEqual(0);
      // Every parent is a span of the same run, and starts no later than its child.
      if (s.parent !== 0) {
        const parent = byId.get(s.parent);
        expect(parent).toBeDefined();
        expect(parent!.startMs).toBeLessThanOrEqual(s.startMs);
      }
    }
    const names = new Set(spans.map((s) => s.name));
    for (const n of ["observe", "observe.prep", "fast.rank", "slow", "search", "source.search", "sanitize"]) {
      expect(names.has(n)).toBe(true);
    }
    for (const n of ["cache.put", "rank", "confident", "deliver", "render", "probes"]) expect(names.has(n)).toBe(true);
    // Roots are events, carrying their session and decision; a lookup's phases hang under its slow span.
    const roots = spans.filter((s) => s.parent === 0);
    expect(roots.every((r) => r.name === "observe" || r.name === "ask")).toBe(true);
    expect(roots.some((r) => r.attrs?.session === "s1")).toBe(true);
    const slow = spans.find((s) => s.name === "slow")!;
    expect(byId.get(slow.parent)!.name).toBe("observe");
    expect(spans.find((s) => s.name === "rank")!.parent).toBe(slow.id);
    // The gate's span is a child of the source call whose page it redacted.
    for (const g of spans.filter((s) => s.name === "sanitize")) {
      expect(byId.get(g.parent)?.name).toMatch(/^source\.(search|fetch)$/);
    }
    // A source call names its connector and page size, nothing else.
    const call = spans.find((s) => s.name === "source.search")!;
    expect(["crm", "calendar"]).toContain(call.attrs!.source as string);
    expect(typeof call.attrs!.items).toBe("number");
  });

  test("spans are content-free: no request word, item text or item id (D19)", async () => {
    const spans: Span[] = [];
    const { p } = partner({ config: H, onSpan: (s) => spans.push(s) });
    await play(p);
    await p.ask({ ...scope, sessionId: "s2", question: "What is quuxfrobnicate about Zorblax?" });
    const all = JSON.stringify(spans).toLowerCase();
    for (const w of SECRETISH) expect(all).not.toContain(w.toLowerCase());
    expect(spans.some((s) => s.name === "ask" && s.parent === 0)).toBe(true);
  });

  test("a model call is a span with its tokens and cost; the judge's input build is its own phase", async () => {
    const spans: Span[] = [];
    const model = new FakeModel(() => '{"use":[0]}');
    const { p } = partner({ config: { probes: true }, model, onSpan: (s) => spans.push(s) });
    await p.observe(ev("s1", { kind: "user_message", text: "Anything about Initech I should know before the call?" }), {
      waitMs: 2_000,
    });
    const call = spans.find((s) => s.name === "model");
    expect(call).toBeDefined();
    expect(call!.attrs!.role).toBe("judge");
    expect(typeof call!.attrs!.inputTokens).toBe("number");
    expect(spans.some((s) => s.name === "judge.build")).toBe(true);
  });

  test("config.spans keeps per-phase totals with no sink", async () => {
    const { p } = partner({ config: { ...H, spans: true } });
    await play(p);
    const stats = p.spanStats();
    const observe = stats.find((s) => s.name === "observe")!;
    expect(observe.count).toBe(2);
    expect(observe.p50Ms).toBeGreaterThan(0);
    expect(observe.p99Ms).toBeGreaterThanOrEqual(observe.p50Ms);
    expect(stats.find((s) => s.name === "source.search")!.count).toBeGreaterThan(0);
  });

  test("a sink that throws never breaks a lookup", async () => {
    const { p } = partner({
      config: H,
      onSpan: () => {
        throw new Error("broken sink");
      },
    });
    const [first] = await play(p);
    expect(first!.length).toBeGreaterThan(0);
  });

  test("per-phase totals are bounded in names and hold no user state", () => {
    const stats = new SpanStats();
    for (let i = 0; i < 1_000; i++) {
      stats.record({ id: i + 1, parent: 0, name: `n${i}`, startMs: 0, endMs: 1, cpuUs: 5 });
    }
    expect(stats.snapshot().length).toBe(128);
    // An asynchronous span's CPU includes what ran meanwhile: not added to the phase's CPU.
    const s2 = new SpanStats();
    s2.record({ id: 1, parent: 0, name: "x", startMs: 0, endMs: 2, cpuUs: 1_000 });
    s2.record({ id: 2, parent: 0, name: "x", startMs: 0, endMs: 2, cpuUs: 9_000, attrs: { async: true } });
    expect(s2.snapshot()[0]!.cpuMs).toBe(1);
    expect(s2.snapshot()[0]!.wallMs).toBe(4);
  });

  test("two users' events are separate trees: no span of one hangs under the other's root", async () => {
    const spans: Span[] = [];
    const { p } = partner({ config: H, onSpan: (s) => spans.push(s) });
    await Promise.all([
      play(p, "a"),
      p.observe(
        { ...ev("b", { kind: "user_message", text: "Initech annual payment: who to contact?" }), userId: "u2" },
        {
          waitMs: 2_000,
        },
      ),
    ]);
    const byId = new Map(spans.map((s) => [s.id, s]));
    const rootOf = (s: Span): Span => (s.parent === 0 ? s : rootOf(byId.get(s.parent)!));
    const sessions = new Set(spans.filter((s) => s.parent === 0).map((s) => s.attrs?.session));
    expect(sessions).toEqual(new Set(["a", "b"]));
    // Every lookup phase reaches the root of the event that started it.
    for (const s of spans.filter((x) => x.name === "slow")) expect(rootOf(s).name).toBe("observe");
  });

  test("a tracer's cost per span is small (CPU per open and close)", () => {
    const tracer = new Tracer(() => {});
    const n = 20_000;
    const c0 = process.cpuUsage();
    for (let i = 0; i < n; i++) tracer.close(tracer.open("rank", 1, { k: i }), { n: 1 });
    const c = process.cpuUsage(c0);
    const perSpanUs = (c.user + c.system) / n;
    // ~1-2 µs measured (two `process.cpuUsage` reads); 25 µs leaves room for a loaded machine.
    expect(perSpanUs).toBeLessThan(25);
  });
});
