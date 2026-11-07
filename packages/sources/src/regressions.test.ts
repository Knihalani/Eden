/** Regressions from the 2026-10-29 audit of the sources: each test failed before its fix. */
import type { ContextItem } from "@eden/protocol";
import type { Source } from "./source";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpSource, ReadOnlyViolation } from "./mcp-source";
import { PlannedSource, QueryPlanner } from "./planner";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SourceFanout } from "./guarded";
import { describe, expect, test } from "bun:test";
import { z } from "zod";

describe("busy burns rate token", () => {
  const scope = { tenantId: "t", userId: "u" };
  const item: ContextItem = { id: "s:1", sourceId: "s", ref: "1", title: "t", text: "x" };

  test("a lookup skipped as 'busy' does not spend a rate-limit token (no call was made)", async () => {
    const now = 0;
    const f = new SourceFanout({ sanitize: (x) => x, cacheBytes: 0, ratePerSec: 0.001, burst: 3, now: () => now });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const src = { id: "s", kind: "t", description: "", search: async () => (calls++, await gate, [item]) };
    const q = (text: string) => ({ scope, text, entities: [], limit: 5 });
    const p1 = f.search([src], q("a"), { timeoutMs: 1_000 });
    const p2 = f.search([src], q("b"), { timeoutMs: 1_000 }); // AIMD starts at 2: both admitted
    const [busy] = await f.search([src], q("c"), { timeoutMs: 1_000 });
    expect(busy!.status).toBe("busy");
    release();
    await Promise.all([p1, p2]);
    // Two calls made against a burst of 3: one more call should be allowed.
    const [d] = await f.search([src], q("d"), { timeoutMs: 1_000 });
    expect(d!.status).toBe("ok"); // actual: "limited"
    expect(calls).toBe(3);
  });
});

describe("forget during search writes back", () => {
  const scope = { tenantId: "t", userId: "u" };
  const item: ContextItem = { id: "s:1", sourceId: "s", ref: "1", title: "t", text: "pre-forget content" };

  test("a search still running when its user is forgotten does not cache its result afterwards", async () => {
    const f = new SourceFanout({ sanitize: (x) => x });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const src = { id: "s", kind: "t", description: "", search: async () => (calls++, await gate, [item]) };
    const q = { scope, text: "q", entities: [], limit: 5 };
    const running = f.search([src], q, { timeoutMs: 1_000 });
    f.forget(scope); // account deletion while the lookup is in flight (caller passed no signal)
    release();
    await running;
    const [after] = await f.search([src], q, { timeoutMs: 1_000 });
    // planCalls guards this with its `forgets` counter; the lookup path does not.
    expect(after!.status).not.toBe("cached"); // actual: "cached", holding the forgotten user's content
  });
});

describe("gate failure breaker", () => {
  const scope = { tenantId: "t", userId: "u" };
  const item: ContextItem = { id: "s:1", sourceId: "s", ref: "1", title: "t", text: "x" };

  test("a failing gate during search() must not count against a healthy source (as fetch() already guarantees)", async () => {
    const f = new SourceFanout({
      sanitize: () => {
        throw new Error("gate failed for 1 of 1 items");
      },
      breaker: { minCalls: 2, failureRate: 0.5, openMs: 60_000 },
      ratePerSec: 100,
      burst: 100,
      cacheBytes: 0,
    });
    let calls = 0;
    const src = { id: "s", kind: "t", description: "", search: async () => (calls++, [item]) };
    for (let i = 0; i < 3; i++)
      await f.search([src], { scope, text: `q${i}`, entities: [], limit: 5 }, { timeoutMs: 1_000 });
    const [out] = await f.search([src], { scope, text: "q9", entities: [], limit: 5 }, { timeoutMs: 1_000 });
    // The source answered every call; only our own gate failed. Yet the breaker is open and the source is skipped.
    expect(out!.status).not.toBe("open");
    expect(calls).toBe(4);
  });
});

describe("halfopen probe leak", () => {
  const scope = { tenantId: "t", userId: "u" };
  const item: ContextItem = { id: "s:1", sourceId: "s", ref: "1", title: "t", text: "x" };

  test("a half-open probe taken and then skipped as 'limited' does not block the source for another openMs", async () => {
    let now = 0;
    const f = new SourceFanout({
      sanitize: (x) => x,
      breaker: { minCalls: 1, failureRate: 0.5, openMs: 30_000 },
      cacheBytes: 0,
      now: () => now,
    });
    let calls = 0;
    const src = {
      id: "s",
      kind: "t",
      description: "",
      search: async () => {
        calls++;
        if (calls === 1) throw new Error("429 Too Many Requests, retry after 35");
        return [item];
      },
    };
    const q = (text: string) => ({ scope, text, entities: [], limit: 5 });
    const [a] = await f.search([src], q("a"), { timeoutMs: 1_000 }); // trips breaker, rate penalised 35 s
    // The connector's own 429: "throttled" since D212 (it was "error"); the breaker still counts it as a failure.
    expect(a!.status).toBe("throttled");
    now = 30_000; // breaker half-open, rate limit still held
    const [b] = await f.search([src], q("b"), { timeoutMs: 1_000 });
    expect(b!.status).toBe("limited"); // the breaker's single probe was consumed here, with no call made
    now = 36_000; // rate limit over, breaker is half-open and nobody is probing
    const [c] = await f.search([src], q("c"), { timeoutMs: 1_000 });
    expect(c!.status).toBe("ok"); // actual: "open" until t = 60 s
    expect(calls).toBe(2);
  });

  test("same leak through fetch()", async () => {
    let now = 0;
    const f = new SourceFanout({
      sanitize: (x) => x,
      breaker: { minCalls: 1, failureRate: 0.5, openMs: 30_000 },
      now: () => now,
    });
    let calls = 0;
    const src = {
      id: "s",
      kind: "t",
      description: "",
      search: async () => [],
      fetch: async () => {
        calls++;
        if (calls === 1) throw new Error("429 rate limited, Retry-After: 35");
        return item;
      },
    };
    expect(await f.fetch(src, scope, "1", { timeoutMs: 1_000 })).toBeNull();
    now = 30_000;
    expect(await f.fetch(src, scope, "1", { timeoutMs: 1_000 })).toBeNull(); // limited, probe consumed
    now = 36_000;
    expect(await f.fetch(src, scope, "1", { timeoutMs: 1_000 })).not.toBeNull(); // actual: null (breaker 'open')
  });
});

describe("mcp listtools pagination", () => {
  test("a read-only search tool on the second page of a paginated tools/list is found", async () => {
    const src = new McpSource({
      id: "big",
      description: "",
      transport: () => {
        const server = new Server({ name: "big", version: "1" }, { capabilities: { tools: {} } });
        const tool = (name: string) => ({
          name,
          inputSchema: { type: "object" as const, properties: { query: { type: "string" } } },
          annotations: { readOnlyHint: true },
        });
        server.setRequestHandler(ListToolsRequestSchema, async (req) =>
          req.params?.cursor === "p2"
            ? { tools: [tool("search_notes")] }
            : { tools: [tool("list_repos")], nextCursor: "p2" },
        );
        server.setRequestHandler(CallToolRequestSchema, async () => ({
          content: [{ type: "text", text: JSON.stringify([{ id: "n1", text: "hello" }]) }],
        }));
        const [client, s] = InMemoryTransport.createLinkedPair();
        void server.connect(s);
        return client;
      },
      searchTool: { name: "search_notes", args: (q) => ({ query: q.text }) },
    });
    const q = { scope: { tenantId: "t", userId: "u" }, text: "hello", entities: [], limit: 5 };
    // Actual: throws "big: server has no tool search_notes", and the source is dead for RETRY_AFTER_MS at a time.
    expect((await src.search(q, AbortSignal.timeout(1_000))).length).toBe(1);
  });
});

describe("mcp reconnect", () => {
  // A server whose search tool is read-only on the first connect and, optionally, not on later ones.
  const source = (options: { quickCloseMs?: number; laterWritable?: boolean } = {}) => {
    const state = { connects: 0, serverSide: null as InMemoryTransport | null };
    const src = new McpSource({
      id: "notes",
      description: "",
      quickCloseMs: options.quickCloseMs,
      transport: () => {
        state.connects++;
        const server = new McpServer({ name: "notes", version: "1" });
        const readOnly = state.connects === 1 || !options.laterWritable;
        server.registerTool(
          "search_notes",
          { inputSchema: { query: z.string() }, annotations: { readOnlyHint: readOnly } },
          async () => ({ content: [{ type: "text", text: JSON.stringify([{ id: "n1", text: "hello" }]) }] }),
        );
        const [client, s] = InMemoryTransport.createLinkedPair();
        state.serverSide = s;
        void server.connect(s);
        return client;
      },
      searchTool: { name: "search_notes", args: (q) => ({ query: q.text }) },
    });
    return { src, state };
  };
  const q = { scope: { tenantId: "t", userId: "u" }, text: "hello", entities: [], limit: 5 };
  const signal = () => AbortSignal.timeout(1_000);
  const drop = async (state: { serverSide: InMemoryTransport | null }) => {
    await state.serverSide!.close(); // the stdio server crashed / the HTTP session expired
    await Bun.sleep(5);
  };

  test("after the connection drops, the next search connects again", async () => {
    const { src, state } = source({ quickCloseMs: 0 });
    expect((await src.search(q, signal())).length).toBe(1);
    await drop(state);
    expect((await src.search(q, signal())).length).toBe(1);
    expect(state.connects).toBe(2);
  });

  test("a connection that closes right after connecting waits before the next connect", async () => {
    const { src, state } = source();
    expect((await src.search(q, signal())).length).toBe(1);
    await drop(state);
    await expect(src.search(q, signal())).rejects.toThrow(/connection closed/);
    expect(state.connects).toBe(1);
  });

  test("a deliberate close right after connecting sets no backoff", async () => {
    const { src, state } = source();
    expect((await src.search(q, signal())).length).toBe(1);
    await src.close();
    expect((await src.search(q, signal())).length).toBe(1);
    expect(state.connects).toBe(2);
  });

  test("a reconnect checks the tool is read-only again (D7)", async () => {
    const { src, state } = source({ quickCloseMs: 0, laterWritable: true });
    expect((await src.search(q, signal())).length).toBe(1);
    await drop(state);
    await expect(src.search(q, signal())).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(state.connects).toBe(2);
  });
});

describe("gate failures and late reports", () => {
  const scope = { tenantId: "t", userId: "u" };
  const item: ContextItem = { id: "s:1", sourceId: "s", ref: "1", title: "t", text: "dana lee" };
  const query = (text: string) => ({ scope, text, entities: [], limit: 5 });

  test("a gate failure inside the query planner's calls does not open the source's breaker", async () => {
    const f = new SourceFanout({
      sanitize: () => {
        throw new Error("gate failed");
      },
      breaker: { minCalls: 2, failureRate: 0.5, openMs: 60_000 },
      ratePerSec: 100,
      burst: 100,
      cacheBytes: 0,
    });
    let calls = 0;
    const src: Source = { id: "s", kind: "t", description: "", search: async () => (calls++, [item]) };
    const planned = () =>
      new PlannedSource(src, new QueryPlanner({ seed: 1, epsilon: 0 }), () => f.permit(scope, "s"), f.planCalls(src));
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await f.search([planned()], query(`dana lee ${i}`), { timeoutMs: 1_000 }))[0]!.status);
    expect(statuses).toEqual(["error", "error", "error", "error"]);
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  test("a source that answers so late the gate times out is reported as a timeout", async () => {
    const f = new SourceFanout({
      sanitize: (_items, signal) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ratePerSec: 100,
      burst: 100,
      cacheBytes: 0,
    });
    const src: Source = { id: "s", kind: "t", description: "", search: async () => [item] };
    const [out] = await f.search([src], query("dana"), { timeoutMs: 30 });
    expect(out!.status).toBe("timeout");
  });

  test("a deadline that runs out in our gate after the source answered says nothing against the source", async () => {
    const f = new SourceFanout({
      sanitize: (_items, signal) =>
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
      breaker: { minCalls: 1, failureRate: 0.5, openMs: 60_000 },
      ratePerSec: 100,
      burst: 100,
      cacheBytes: 0,
    });
    let calls = 0;
    const src: Source = { id: "s", kind: "t", description: "", search: async () => (calls++, [item]) };
    for (const text of ["a", "b"])
      expect((await f.search([src], query(text), { timeoutMs: 20 }))[0]!.status).toBe("timeout");
    expect(calls).toBe(2); // the breaker did not open after the first
  });

  test("a call allowed before the breaker opened that fails late does not push the probe back", async () => {
    let now = 0;
    let fail!: (e: Error) => void;
    let n = 0;
    const src: Source = {
      id: "s",
      kind: "t",
      description: "",
      search: async () => {
        const call = ++n;
        if (call === 1) await new Promise<void>((_, reject) => (fail = reject)); // hangs, then fails late
        if (call === 2) throw new Error("upstream 500");
        return [item];
      },
    };
    const f = new SourceFanout({
      sanitize: (items) => items,
      breaker: { minCalls: 1, failureRate: 0.5, openMs: 1_000 },
      ratePerSec: 100,
      burst: 100,
      cacheBytes: 0,
      now: () => now,
    });
    const first = f.search([src], query("a"), { timeoutMs: 5_000 });
    await Bun.sleep(1);
    await f.search([src], query("b"), { timeoutMs: 5_000 }); // fails: the breaker opens at t=0
    now = 900;
    fail(new Error("upstream 500"));
    expect((await first)[0]!.status).toBe("error");
    now = 1_000; // openMs after the trip: the probe may go
    expect((await f.search([src], query("c"), { timeoutMs: 5_000 }))[0]!.status).toBe("ok");
  });
});

/** Regressions from the 2026-11-05 audit of the results cache (scale and drop findings). */
describe("results cache: real bytes, group drops, drops across state eviction", () => {
  type Who = { tenantId: string; userId: string };
  const item = (text: string): ContextItem => ({ id: "s:1", sourceId: "s", ref: "1", title: "t", text });
  const src = (id: string, search: Source["search"]): Source => ({ id, kind: "t", description: "", search });
  const q = (scope: Who, text: string) => ({ scope, text, entities: [], limit: 5 });
  const signal = () => new AbortController().signal;

  test("50,000 empty pages with ~120-char keys keep heap growth under a 4 MB cache budget", async () => {
    const { heapStats } = await import("bun:jsc");
    let now = 0;
    const f = new SourceFanout({
      sanitize: (x) => x,
      cacheBytes: 4_000_000,
      ratePerSec: 1e9,
      burst: 1e9,
      now: () => now,
    });
    const empty = src("mail-connector", async () => []);
    const users = Array.from({ length: 50 }, (_, i) => ({ tenantId: `tenant-${i}`, userId: `user-${i}-abcdefgh` }));
    const pad = "x".repeat(60);
    // Warm up (state per user, JIT) before the baseline.
    for (const u of users) await f.search([empty], q(u, "warm"), { timeoutMs: 1_000 });
    Bun.gc(true);
    const before = heapStats().heapSize;
    // One page every 30 simulated ms: 1,500 s, past the 600 s expiry for most pages, and far past the byte budget
    // (every page held would be ~17 MB at the pre-fix ~345 B each).
    for (let i = 0; i < 50_000; i++) {
      now += 30;
      const text = `quarterly invoice renewal ${i} ${pad}`;
      const [out] = await f.search([empty], q(users[i % 50]!, text), { timeoutMs: 1_000 });
      if (out!.status !== "ok") throw new Error(out!.status);
    }
    Bun.gc(true);
    const grew = heapStats().heapSize - before;
    const inner = f as unknown as { results: { bytes: number; size: number } | null };
    expect(inner.results!.bytes).toBeLessThanOrEqual(4_000_000);
    expect(inner.results!.size).toBeLessThan(10_000); // before the fix: 50,050 (an empty page cost 1 byte)
    // The heap the cache holds: growth minus what is left once the cache itself is let go.
    inner.results = null;
    Bun.gc(true);
    const heldByCache = grew - (heapStats().heapSize - before);
    expect(heldByCache).toBeLessThan(4_000_000); // before the fix: ~17 MB (~345 B per entry, every entry held)
    expect(grew).toBeLessThan(5_000_000); // the rest is the fan-out's own state, ~0.25 MB
  }, 30_000);

  test("dropResults(a, 's') removes only that pair's pages, lookups and planner calls alike", async () => {
    const f = new SourceFanout({ sanitize: (x) => x, ratePerSec: 1_000, burst: 1_000 });
    const a = { tenantId: "t", userId: "a" };
    const b = { tenantId: "t", userId: "b" };
    // Ids that look like each other's prefixes: user "a" vs "a|s", source "s" vs "s|x".
    const aPipe = { tenantId: "t", userId: "a|s" };
    const s = src("s", async () => [item("page")]);
    const s2 = src("s2", async () => [item("page")]);
    const sx = src("s|x", async () => [item("page")]);
    const plan = f.planCalls(s);
    await plan.call(q(a, "plan query"), signal());
    const pairs: [Who, Source][] = [
      [a, s],
      [a, s2],
      [a, sx],
      [b, s],
      [aPipe, s],
    ];
    for (const [scope, source] of pairs) await f.search([source], q(scope, "renewal"), { timeoutMs: 1_000 });
    expect(plan.cached(q(a, "plan query"))).toBeDefined();
    f.dropResults(a, "s");
    expect(plan.cached(q(a, "plan query"))).toBeUndefined();
    const status = async (scope: Who, source: Source) =>
      (await f.search([source], q(scope, "renewal"), { timeoutMs: 1_000 }))[0]!.status;
    expect(await status(a, s2)).toBe("cached");
    expect(await status(a, sx)).toBe("cached");
    expect(await status(b, s)).toBe("cached");
    expect(await status(aPipe, s)).toBe("cached");
    expect(await status(a, s)).toBe("ok"); // asked again
    // Forgetting one of a's sources leaves a's others; forgetting a leaves b.
    f.forget(a, "s2");
    expect(await status(a, s2)).toBe("ok");
    expect(await status(a, sx)).toBe("cached");
    f.forget(a);
    expect(await status(a, sx)).toBe("ok");
    expect(await status(b, s)).toBe("cached");
  });

  test("a drop while the pair's state was evicted mid-call still keeps the old page from being held", async () => {
    // Before the fix the drop was counted on the evicted state: lost, and the in-flight page was written back.
    const f = new SourceFanout({ sanitize: (x) => x, maxStates: 8, ratePerSec: 1_000, burst: 1_000 });
    const a = { tenantId: "t", userId: "a" };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let text = "old";
    const slow = src("s", async () => {
      const seen = text;
      if (seen === "old") await gate;
      return [item(seen)];
    });
    const running = f.search([slow], q(a, "renewal"), { timeoutMs: 5_000 });
    await Bun.sleep(1);
    // Other pairs push a's state out of the 8-pair LRU.
    const quick = src("s", async () => []);
    for (let i = 0; i < 20; i++)
      await f.search([quick], q({ tenantId: "t", userId: `o${i}` }, "x"), { timeoutMs: 1_000 });
    f.dropResults(a, "s"); // the source changed
    text = "new";
    release();
    expect((await running)[0]!.items[0]!.text).toBe("old");
    const [after] = await f.search([slow], q(a, "renewal"), { timeoutMs: 1_000 });
    expect(after!.status).not.toBe("cached");
    expect(after!.items[0]!.text).toBe("new");
    // The same through the planner's calls, whose pair may have no state at all.
    let releasePlan!: () => void;
    const planGate = new Promise<void>((r) => (releasePlan = r));
    let planText = "old";
    const planSrc = src("p", async () => {
      const seen = planText;
      if (seen === "old") await planGate;
      return [item(seen)];
    });
    const plan = f.planCalls(planSrc);
    const call = plan.call(q(a, "plan"), signal());
    await Bun.sleep(1);
    f.dropResults(a, "p");
    planText = "new";
    releasePlan();
    await call;
    expect(plan.cached(q(a, "plan"))).toBeUndefined();
  });

  test("isolation: one user's drops never stop another user's in-flight call from holding its page", async () => {
    const f = new SourceFanout({ sanitize: (x) => x, maxStates: 4, ratePerSec: 1_000, burst: 1_000 });
    const a = { tenantId: "t", userId: "a" };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = src("s", async () => (await gate, [item("a's page")]));
    const running = f.search([slow], q(a, "renewal"), { timeoutMs: 5_000 });
    const plan = f.planCalls(slow);
    const planned = plan.call(q(a, "plan"), signal());
    await Bun.sleep(1);
    // Many other users' drops: for pairs with state, without state, and evicted (a's own state is evicted too).
    for (let i = 0; i < 20; i++) {
      const other = { tenantId: "t", userId: `b${i}` };
      if (i % 2 === 0) await f.search([src("s", async () => [])], q(other, "x"), { timeoutMs: 1_000 });
      f.dropResults(other, "s");
    }
    release();
    await Promise.all([running, planned]);
    expect((await f.search([slow], q(a, "renewal"), { timeoutMs: 1_000 }))[0]!.status).toBe("cached");
    expect(plan.cached(q(a, "plan"))).toBeDefined();
    // Nothing is left behind once the calls end: the running-call records go with them.
    expect((f as unknown as { running: Map<string, unknown> }).running.size).toBe(0);
  });
});

describe("held: a cache-only read of the page a search would be answered from (D140)", () => {
  const a = { tenantId: "t", userId: "a" };
  const b = { tenantId: "t", userId: "b" };
  const item: ContextItem = { id: "s:1", sourceId: "s", ref: "1", title: "t", text: "x" };
  const q = (scope: typeof a, text = "x") => ({ scope, text, entities: ["Dana"], limit: 5 });

  test("no rate token, call or breaker probe: a held page read 50 times leaves the next call its token", async () => {
    // A burst of 2 and no refill to speak of: the first search takes one token, so one call is left.
    const f = new SourceFanout({ sanitize: (x) => x, ratePerSec: 1e-9, burst: 2, now: () => 0 });
    let calls = 0;
    const src = { id: "s", kind: "t", description: "", search: async () => (calls++, [item]) };
    expect((await f.search([src], q(a), { timeoutMs: 1_000 }))[0]!.status).toBe("ok");
    const rate = (f as unknown as { rate: { available(k: string): number } }).rate;
    const before = rate.available("t/a|s");
    expect(before).toBe(1); // The key is the pair's: the first call took one of two.
    for (let i = 0; i < 50; i++) expect(f.held("s", q(a))?.status).toBe("cached");
    expect(calls).toBe(1);
    expect(rate.available("t/a|s")).toBe(before);
    // The token the reads did not spend: a different query is still admitted, then the bucket is empty.
    expect((await f.search([src], q(a, "y"), { timeoutMs: 1_000 }))[0]!.status).toBe("ok");
    expect((await f.search([src], q(a, "z"), { timeoutMs: 1_000 }))[0]!.status).toBe("limited");
  });

  test("the same key as the search: a page found only for the same limit, text, entities and window", async () => {
    const f = new SourceFanout({ sanitize: (x) => x, ratePerSec: 1_000, burst: 1_000 });
    const src = { id: "s", kind: "t", description: "", search: async () => [item] };
    const windowed = { ...q(a), window: { start: "2026-11-01", end: "2026-11-02" } };
    await f.search([src], q(a), { timeoutMs: 1_000 });
    await f.search([src], windowed, { timeoutMs: 1_000 });
    expect(f.held("s", q(a))?.items).toEqual([item]);
    expect(f.held("s", windowed)?.status).toBe("cached");
    expect(f.held("s", { ...windowed, window: { start: "2026-11-01", end: "2026-11-03" } })).toBeUndefined();
    expect(f.held("s", { ...q(a), limit: 6 })).toBeUndefined();
    expect(f.held("s", { ...q(a), entities: [] })).toBeUndefined();
    expect(f.held("s", { ...q(a), text: "X" })).toBeUndefined();
    expect(f.held("other", q(a))).toBeUndefined();
    expect(f.held("s", q(b))).toBeUndefined(); // Another user's page is never read.
  });

  test("fresh is cached, past freshMs stale with error timeout, past staleMs gone; a drop or forget empties it", async () => {
    let now = 0;
    const f = new SourceFanout({
      sanitize: (x) => x,
      ratePerSec: 1_000,
      burst: 1_000,
      freshMs: 100,
      staleMs: 1_000,
      now: () => now,
    });
    const src = { id: "s", kind: "t", description: "", search: async () => [item] };
    await f.search([src], q(a), { timeoutMs: 1_000 });
    await f.search([src], q(b), { timeoutMs: 1_000 });
    expect(f.held("s", q(a))).toEqual({ sourceId: "s", status: "cached", items: [item], latencyMs: 0 });
    now = 500;
    expect(f.held("s", q(a))).toEqual({
      sourceId: "s",
      status: "stale",
      items: [item],
      latencyMs: 0,
      error: "timeout",
    });
    f.dropResults(a, "s");
    expect(f.held("s", q(a))).toBeUndefined();
    expect(f.held("s", q(b))?.status).toBe("stale"); // Only that user's pages went.
    f.forget(b, "s");
    expect(f.held("s", q(b))).toBeUndefined();
    await f.search([src], q(a), { timeoutMs: 1_000 });
    now = 2_000;
    expect(f.held("s", q(a))).toBeUndefined();
  });
});
