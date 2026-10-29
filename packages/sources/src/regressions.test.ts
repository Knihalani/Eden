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
    expect(a!.status).toBe("error");
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
