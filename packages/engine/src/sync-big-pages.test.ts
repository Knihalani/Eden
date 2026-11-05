import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { itemId, type ContextItem, type Scope } from "@eden/protocol";
import { McpSource, type ListPage, type McpSourceOptions, type SearchQuery, type Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { DEFAULT_CONFIG } from "./config";
import { checkEngineConfig } from "./config-check";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 5, 9);

/**
 * An offset-paged connector that records every list call's `limit`. `listPageMax` is what it declares; `rejectBig`
 * makes it throw on any page above 100 (a server whose real cap is lower than it said, or that refuses big pages).
 */
class PagedSource implements Source {
  readonly kind = "test";
  readonly description = "test";
  limits: number[] = [];
  rejectBig = false;
  items: ContextItem[];
  constructor(
    readonly id: string,
    n: number,
    readonly listPageMax?: number,
  ) {
    this.items = Array.from({ length: n }, (_, i) => ({
      id: itemId(id, `r${i}`),
      sourceId: id,
      ref: `r${i}`,
      title: `Row ${i}`,
      text: `Row ${i} of ${id}`,
      updatedAt: T0 - i * 60_000,
    }));
  }
  async search(_q: SearchQuery): Promise<ContextItem[]> {
    return [];
  }
  async list(_scope: Scope, cursor: string | undefined, limit: number): Promise<ListPage> {
    this.limits.push(limit);
    if (this.rejectBig && limit > 100) throw new Error("400 Bad Request: limit must be at most 100");
    const at = cursor ? Number(cursor) : 0;
    return {
      items: this.items.slice(at, at + limit),
      next: at + limit < this.items.length ? String(at + limit) : null,
    };
  }
}

function setup(resolve: (scope: Scope) => Source[], config: Record<string, unknown> = {}) {
  let clock = T0;
  const cache = new ItemCache();
  const partner = new ContextPartner({
    sources: async (scope) => resolve(scope),
    sourceMap: new SourceMap(":memory:", { seed: 1 }),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
    // The core with only the sync on, at the default's page sizes (`syncBigPageSize` 500, D142).
    config: {
      ...CORE_CONFIG,
      sync: true,
      syncCallsPerMin: 600,
      syncSweepMs: HOUR,
      syncBigPageSize: DEFAULT_CONFIG.syncBigPageSize,
      ...config,
    },
  });
  return { partner, cache, advance: (ms: number) => (clock += ms), now: () => clock };
}

const scope: Scope = { tenantId: "t1", userId: "u1" };

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

/**
 * A real `McpSource` over an in-process JSON-RPC fake (the engine does not depend on the MCP SDK's server side): a
 * read-only, offset-paged `list_rows` whose schema declares `maximum: 500` on `limit` but which returns at most 100
 * rows a page, silently (finding 14: a server that caps below what it says).
 */
function cappingConnector(rows: { id: string; title: string; text: string }[]) {
  const listCalls: Record<string, unknown>[] = [];
  const tools = [
    {
      name: "search_rows",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      annotations: { readOnlyHint: true },
    },
    {
      name: "list_rows",
      inputSchema: {
        type: "object",
        properties: { offset: { type: "integer" }, limit: { type: "integer", maximum: 500 } },
      },
      annotations: { readOnlyHint: true },
    },
  ];
  const answer = (m: Message): unknown => {
    if (m.method === "initialize") {
      return {
        protocolVersion: m.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "rows", version: "1" },
      };
    }
    if (m.method === "tools/list") return { tools };
    if (m.method === "tools/call") {
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      if (m.params?.name === "search_rows") return { content: [{ type: "text", text: "[]" }] };
      listCalls.push(args);
      const at = Number(args.offset ?? 0);
      const page = rows.slice(at, at + Math.min(Number(args.limit ?? 20), 100));
      return { content: [{ type: "text", text: JSON.stringify({ rows: page }) }] };
    }
    return {};
  };
  const transport = () => {
    const t = {
      onmessage: undefined as ((m: unknown) => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      onerror: undefined as ((e: Error) => void) | undefined,
      async start() {},
      async close() {
        t.onclose?.();
      },
      async send(raw: unknown) {
        const m = raw as Message;
        if (m.id === undefined) return;
        const result = answer(m);
        queueMicrotask(() => t.onmessage?.({ jsonrpc: "2.0", id: m.id, result }));
      },
    };
    return t as unknown as ReturnType<McpSourceOptions["transport"]>;
  };
  const source = new McpSource({
    id: "rows",
    description: "rows",
    transport,
    searchTool: { name: "search_rows" },
    listTool: { name: "list_rows" },
  });
  return { source, listCalls };
}

/**
 * Ticks until the user's backfill is done. The clock moves 2 s a tick: the fan-out's serving rate limit (5/s, burst
 * 10, background calls leaving 2 of it) runs on the engine's clock, so a listing of 12 pages needs time to refill.
 */
async function warm(env: ReturnType<typeof setup>, s: Scope = scope) {
  env.partner.sync!.track(s);
  for (let i = 0; i < 50 && !env.partner.sync!.warm(s); i++) {
    await env.partner.sync!.tick();
    env.advance(2_000);
  }
  expect(env.partner.sync!.warm(s)).toBe(true);
}

/** Runs one sweep to its end (the source's state says when: `sweptAt` moves, so no sweep is due right after). */
async function sweep(env: ReturnType<typeof setup>, s: Scope = scope) {
  env.advance(2 * HOUR);
  env.partner.sync!.track(s);
  for (let i = 0; i < 10; i++) {
    await env.partner.sync!.tick();
    env.advance(2_000);
  }
}

describe("big sync pages (syncBigPageSize, D142)", () => {
  test("the default asks 500 a page of a source that declares 500 safe", () => {
    expect(DEFAULT_CONFIG.syncBigPageSize).toBe(500);
    expect(DEFAULT_CONFIG.syncPageSize).toBe(100);
  });

  test("a source declaring listPageMax 500 is backfilled and swept in pages of 500", async () => {
    const src = new PagedSource("mail", 1_200, 500);
    const env = setup(() => [src]);
    await warm(env);
    expect(src.limits).toEqual([500, 500, 500]);
    expect(env.cache.syncedCount(scope)).toBe(1_200);
    src.limits = [];
    await sweep(env);
    expect(src.limits).toEqual([500, 500, 500]);
    expect(env.partner.sync!.stats.deleted).toBe(0);
  });

  test("a source without listPageMax stays at syncPageSize (100)", async () => {
    const src = new PagedSource("mail", 1_200);
    const env = setup(() => [src]);
    await warm(env);
    expect(src.limits).toEqual(Array(12).fill(100));
    src.limits = [];
    await sweep(env);
    expect(src.limits).toEqual(Array(12).fill(100));
  });

  test("the page is the smaller of syncBigPageSize and the source's max; 0 turns big pages off", async () => {
    const small = new PagedSource("mail", 700, 300);
    await warm(setup(() => [small]));
    expect(small.limits).toEqual([300, 300, 300]);
    const off = new PagedSource("mail", 300, 500);
    await warm(setup(() => [off], { syncBigPageSize: 0 }));
    expect(off.limits).toEqual([100, 100, 100]);
    // A declared max below the page size never shrinks the page: the engine's own page is what it always asked.
    const tiny = new PagedSource("mail", 150, 50);
    await warm(setup(() => [tiny]));
    expect(tiny.limits).toEqual([100, 100]);
  });

  test("polls are unchanged: an on-demand poll asks its own small page, not the big one", async () => {
    const src = new PagedSource("mail", 600, 500);
    const env = setup(() => [src], { syncOnDemand: true, syncPollPageSize: 5 });
    await warm(env);
    src.limits = [];
    env.advance(7 * HOUR); // Past `syncMaxStaleMs` (6 h): stale whatever its learned rate.
    await env.partner.sync!.freshen(scope, [src], AbortSignal.timeout(2_000));
    expect(src.limits.length).toBeGreaterThan(0);
    expect(Math.max(...src.limits)).toBeLessThanOrEqual(100);
  });

  test("a source that throws on limit > 100 is retried at 100 in the same tick; later pages and sweeps ask 100", async () => {
    const src = new PagedSource("mail", 250, 500);
    src.rejectBig = true;
    const env = setup(() => [src]);
    env.partner.sync!.track(scope);
    await env.partner.sync!.tick();
    // The first tick: the big page failed, the same page at 100 was read at once, and the backfill went on.
    expect(src.limits).toEqual([500, 100, 100, 100]);
    expect(env.partner.sync!.warm(scope)).toBe(true);
    expect(env.cache.syncedCount(scope)).toBe(250);
    // The failed call is a background call: 4 calls reached the source.
    expect(env.partner.sync!.stats.backgroundCalls).toBe(4);
    src.limits = [];
    await sweep(env);
    expect(src.limits).toEqual([100, 100, 100]);
    await sweep(env);
    expect(src.limits).toEqual([100, 100, 100, 100, 100, 100]);
    // Both sweeps completed: nothing was dropped as missed.
    expect(env.partner.sync!.stats.deleted).toBe(0);
    expect(env.cache.syncedCount(scope)).toBe(250);
  });

  test("a sweep whose big page fails is completed at 100 in the same tick, and drops only what is gone", async () => {
    const src = new PagedSource("mail", 250, 500);
    const env = setup(() => [src]);
    await warm(env);
    expect(src.limits).toEqual([500]);
    src.rejectBig = true;
    src.items = src.items.filter((it) => it.ref !== "r7");
    src.limits = [];
    await sweep(env);
    expect(src.limits).toEqual([500, 100, 100, 100]);
    await sweep(env);
    expect(src.limits.slice(4)).toEqual([100, 100, 100]);
    // Two complete sweeps missed r7: gone; every other row is still synced.
    expect(env.partner.sync!.stats.deleted).toBe(1);
    expect(env.cache.get(scope, itemId("mail", "r7"), env.now())).toBeNull();
    expect(env.cache.syncedCount(scope)).toBe(249);
  });

  test("a source that errs at every page size: one retry at 100, then the read backs off as before", async () => {
    const failing = new PagedSource("mail", 50, 500);
    failing.list = async (_s, _c, limit) => {
      failing.limits.push(limit);
      throw new Error("503 Service Unavailable");
    };
    const env = setup(() => [failing]);
    env.partner.sync!.track(scope);
    await env.partner.sync!.tick();
    expect(failing.limits).toEqual([500, 100]);
    expect(env.partner.sync!.warm(scope)).toBe(false);
    await env.partner.sync!.tick(); // Within the back-off: no call.
    expect(failing.limits).toEqual([500, 100]);
    env.advance(60_000); // Past the first back-off (30 s): the fallback stands, so the next try asks 100.
    await env.partner.sync!.tick();
    expect(failing.limits).toEqual([500, 100, 100]);
  });

  test("isolation: the remembered fallback is per tenant, user and source, and forget clears it", async () => {
    const a = { tenantId: "t1", userId: "u" };
    const b = { tenantId: "t2", userId: "u" }; // Same user id, another tenant.
    const c = { tenantId: "t1", userId: "v" }; // Same tenant, another user.
    const aMail = new PagedSource("mail", 250, 500);
    aMail.rejectBig = true;
    const aDocs = new PagedSource("docs", 250, 500);
    const bMail = new PagedSource("mail", 250, 500);
    const cMail = new PagedSource("mail", 250, 500);
    const of = (s: Scope) => (s.tenantId === "t2" ? [bMail] : s.userId === "v" ? [cMail] : [aMail, aDocs]);
    const env = setup(of);
    for (const s of [a, b, c]) await warm(env, s);
    expect(aMail.limits).toEqual([500, 100, 100, 100]);
    expect(aDocs.limits).toEqual([500]);
    expect(bMail.limits).toEqual([500]);
    expect(cMail.limits).toEqual([500]);
    for (const x of [aMail, aDocs, bMail, cMail]) x.limits = [];
    env.advance(2 * HOUR);
    for (const s of [a, b, c]) env.partner.sync!.track(s);
    for (let i = 0; i < 10; i++) {
      await env.partner.sync!.tick();
      env.advance(2_000);
    }
    expect(aMail.limits).toEqual([100, 100, 100]);
    expect(aDocs.limits).toEqual([500]);
    expect(bMail.limits).toEqual([500]);
    expect(cMail.limits).toEqual([500]);
    // Forgotten, the user's sync state goes, and with it the fallback: back, the source is asked big again.
    env.partner.forget(a);
    aMail.rejectBig = false;
    aMail.limits = [];
    await warm(env, a);
    expect(aMail.limits).toEqual([500]);
  });

  test("an MCP offset list that declares 500 but caps at 100: two sweeps at 500 drop nothing (finding 14)", async () => {
    const rows = Array.from({ length: 350 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}`, text: `row ${i}` }));
    const { source, listCalls } = cappingConnector(rows);
    const env = setup(() => [source]);
    await warm(env);
    // The first page is asked before the connect has read the schema: 100. Then 500, capped silently to 100 rows.
    expect(listCalls.map((c) => c.limit)).toEqual([100, 500, 500, 500, 500]);
    expect(env.cache.syncedCount(scope)).toBe(350);
    listCalls.length = 0;
    await sweep(env);
    await sweep(env);
    // Each sweep: 4 full pages and one empty one (the cap costs a call, never the rows past it).
    expect(listCalls.map((c) => c.offset ?? 0)).toEqual([0, 100, 200, 300, 350, 0, 100, 200, 300, 350]);
    expect(env.partner.sync!.stats.deleted).toBe(0);
    expect(env.cache.syncedCount(scope)).toBe(350);
    for (const r of rows) expect(env.cache.isSynced(scope, itemId("rows", r.id))).toBe(true);
    await source.close();
  });

  test("config check: 0 or at least syncPageSize, at most 1,000, whole", () => {
    expect(checkEngineConfig({ syncBigPageSize: 0 })).toEqual({ syncBigPageSize: 0 });
    expect(checkEngineConfig({ syncBigPageSize: 1_000 })).toEqual({ syncBigPageSize: 1_000 });
    expect(() => checkEngineConfig({ syncBigPageSize: 1_001 })).toThrow(/at most 1000/);
    expect(() => checkEngineConfig({ syncBigPageSize: 250.5 })).toThrow(/whole/);
    expect(() => checkEngineConfig({ syncBigPageSize: 50 })).toThrow(/at least "syncPageSize"/);
    expect(() => checkEngineConfig({ syncBigPageSize: 150, syncPageSize: 200 })).toThrow(/at least/);
    expect(() => checkEngineConfig({ sync: false, syncBigPageSize: 300 })).toThrow(/acts only with "sync"/);
  });
});
