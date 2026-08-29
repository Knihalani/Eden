import { afterAll, describe, expect, test } from "bun:test";
import { IslandReply } from "@eden/ir";
import { dcPct, dcShare } from "@eden/measure";
import { registryFrom } from "@eden/runtime";
import { cacheHitPctFromReceipts } from "../../../packages/cli/src/digest";
import { handleApi } from "./api";
import { dcWindowFromReceipts } from "./dc-window";
import { Store } from "./store";

const PREV_DEV = process.env.EDEN_DEV;
process.env.EDEN_DEV = "1";
afterAll(() => {
  process.env.EDEN_DEV = PREV_DEV;
});

const TOKEN = "k";
const AUTH = { authorization: "Bearer k", "content-type": "application/json" };

function ctx(store = new Store(":memory:")) {
  return { store, token: TOKEN };
}

async function api(store: Store, path: string, init?: RequestInit) {
  const req = new Request(`http://x${path}`, init);
  return handleApi(req, new URL(req.url), ctx(store));
}

describe("receipt token-class payload", () => {
  test("POST /v1/receipts persists tokenClasses and usage extras; GET spreads them", async () => {
    const store = new Store(":memory:");
    const classes = { compiled: 4, memoized: 1, transparent: 0, steeredSkip: 2, frontier: 3, providerCache: 80 };
    const res = await api(store, "/v1/receipts", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        toolId: "wf_1",
        version: "v1",
        ms: 12,
        ok: true,
        tokenClass: "compiled",
        tokenClasses: classes,
        prompt_tokens: 9,
        completion_tokens: 1,
        cached_tokens: 80,
        certified: true,
      }),
    });
    expect(res?.status).toBe(200);
    const got = await api(store, "/v1/receipts", { headers: AUTH });
    const body = (await got!.json()) as { receipts: Array<Record<string, unknown>> };
    expect(body.receipts).toHaveLength(1);
    const row = body.receipts[0]!;
    expect(row.tokenClass).toBe("compiled");
    expect(row.tokenClasses).toEqual(classes);
    expect(row.prompt_tokens).toBe(9);
    expect(row.completion_tokens).toBe(1);
    expect(row.cached_tokens).toBe(80);
    expect(row.certified).toBe(true);
    expect(row.payload).toBeUndefined();
  });

  test("POST /v1/receipts round-trips Anthropic write+denom; digest is 40% not 80%", async () => {
    const store = new Store(":memory:");
    const res = await api(store, "/v1/receipts", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        toolId: "wf_ant",
        version: "v1",
        ms: 8,
        ok: true,
        prompt_tokens: 50,
        cached_tokens: 40,
        cache_write_tokens: 10,
        cache_input_tokens: 100,
        tokenClasses: { compiled: 58, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 0, providerCache: 40 },
      }),
    });
    expect(res?.status).toBe(200);
    const got = await api(store, "/v1/receipts", { headers: AUTH });
    const body = (await got!.json()) as { receipts: Array<Record<string, unknown>> };
    const row = body.receipts[0]!;
    expect(row.prompt_tokens).toBe(50);
    expect(row.cached_tokens).toBe(40);
    expect(row.cache_write_tokens).toBe(10);
    expect(row.cache_input_tokens).toBe(100);
    expect(row.payload).toBeUndefined();
    expect(cacheHitPctFromReceipts([row])).toBe(40);
    expect(cacheHitPctFromReceipts([row])).not.toBe(80);
    expect(cacheHitPctFromReceipts([{ tool_id: "wf_oai", prompt_tokens: 2006, cached_tokens: 1920 }])).toBe(
      (1920 / 2006) * 100,
    );
  });

  test("wrap-run persists island cached_tokens like POST /v1/receipts", async () => {
    const store = new Store(":memory:");
    store.putTool({
      id: "wf_isle",
      name: "isle",
      version: "v1",
      program: {
        id: "wf_isle",
        version: "v1",
        name: "isle",
        description: "isle",
        inputSchema: { type: "object" },
        steps: [
          { id: "i", kind: "island", input: { kind: "literal", value: 1 }, system: "x", outputSchema: { type: "object" } },
        ],
        returns: { kind: "from", step: "i", path: "" },
        contract: { witnesses: 0, minLlmReduction: 2, allowExact: true },
        sequence: ["draft"],
        manifest: null,
      },
      state: "live",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const island = async () =>
      new IslandReply(
        { ok: true },
        {
          prompt_tokens: 50,
          completion_tokens: 8,
          cached_tokens: 40,
          cache_write_tokens: 10,
          cache_input_tokens: 100,
        },
      );
    const req = new Request("http://x/v1/wrap-run", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ toolId: "wf_isle", input: {} }),
    });
    const res = await handleApi(req, new URL(req.url), { store, token: TOKEN, registry: registryFrom({}), island });
    expect(res?.status).toBe(200);
    const got = await api(store, "/v1/receipts", { headers: AUTH });
    const body = (await got!.json()) as { receipts: Array<Record<string, unknown>> };
    const row = body.receipts[0]!;
    expect(row.cached_tokens).toBe(40);
    expect(row.cache_write_tokens).toBe(10);
    expect(row.cache_input_tokens).toBe(100);
    expect(row.prompt_tokens).toBe(50);
    expect(cacheHitPctFromReceipts([row])).toBe(40);
    expect(cacheHitPctFromReceipts([row])).not.toBe(80);
  });

  test("POST /v1/receipts persists capacity reason; GET spreads it for canvas", async () => {
    const store = new Store(":memory:");
    const res = await api(store, "/v1/receipts", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        toolId: "wf_cap",
        version: "v1",
        ms: 0,
        ok: true,
        outcome: "degraded",
        reason: "capacity: session full (64/64), this stretch ran raw",
      }),
    });
    expect(res?.status).toBe(200);
    const got = await api(store, "/v1/receipts?tool=wf_cap", { headers: AUTH });
    const body = (await got!.json()) as { receipts: Array<Record<string, unknown>> };
    expect(body.receipts[0]!.outcome).toBe("degraded");
    expect(body.receipts[0]!.reason).toBe("capacity: session full (64/64), this stretch ran raw");
    expect(body.receipts[0]!.ok).toBe(1);
  });
});

describe("GET /v1/dc", () => {
  test("unauthorized without a key", async () => {
    const store = new Store(":memory:");
    const res = await handleApi(new Request("http://x/v1/dc"), new URL("http://x/v1/dc"), { store, token: TOKEN });
    expect(res?.status).toBe(401);
  });

  test("receipts without tokenClasses leave the window unmeasured", async () => {
    const store = new Store(":memory:");
    const post = await api(store, "/v1/receipts", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ toolId: "wf_1", ok: true, ms: 1 }),
    });
    expect(post?.status).toBe(200);
    const res = await api(store, "/v1/dc?days=7", { headers: AUTH });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      days: Array<{ day: string; dcPct: number; measured: boolean; classes: { compiled: number; frontier: number } }>;
      current: { dcPct: number; measured: boolean };
    };
    expect(body.days).toHaveLength(7);
    expect(body.days.every((d) => d.measured === false && d.dcPct === 0)).toBe(true);
    expect(body.days.every((d) => d.classes.compiled === 0 && d.classes.frontier === 0)).toBe(true);
    expect(body.current).toEqual({ dcPct: 0, measured: false });
  });

  test("today's measured receipt appears on GET /v1/dc", async () => {
    const store = new Store(":memory:");
    const classes = { compiled: 1, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 1, providerCache: 9 };
    await api(store, "/v1/receipts", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ toolId: "wf_1", ok: true, tokenClasses: classes }),
    });
    const res = await api(store, "/v1/dc", { headers: AUTH });
    const body = (await res!.json()) as {
      days: Array<{ dcPct: number; measured: boolean; classes: typeof classes }>;
      current: { dcPct: number; measured: boolean };
    };
    expect(body.days).toHaveLength(7);
    expect(body.current.measured).toBe(true);
    expect(body.current.dcPct).toBe(50);
    const today = body.days[6]!;
    expect(today.measured).toBe(true);
    expect(today.dcPct).toBe(50);
    expect(today.classes.providerCache).toBe(9);
    expect(body.days.slice(0, 6).every((d) => d.measured === false)).toBe(true);
  });
});

describe("dcWindowFromReceipts", () => {
  test("sums tokenClasses per UTC day; providerCache is not in DC%", () => {
    const store = new Store(":memory:");
    const dayA = Date.UTC(2026, 7, 19, 12);
    const dayB = Date.UTC(2026, 7, 20, 8);
    store.putReceipt({
      tool_id: "wf_1",
      version: "1",
      ms: 1,
      llm_calls: 0,
      cents: 0,
      ok: 1,
      created_at: dayA,
      payload: JSON.stringify({
        tokenClasses: { compiled: 10, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 10, providerCache: 500 },
      }),
    });
    store.putReceipt({
      tool_id: "wf_1",
      version: "1",
      ms: 1,
      llm_calls: 0,
      cents: 0,
      ok: 1,
      created_at: dayA + 1000,
      payload: JSON.stringify({
        tokenClasses: { compiled: 5, memoized: 0, transparent: 0, steeredSkip: 5, frontier: 0 },
      }),
    });
    store.putReceipt({
      tool_id: "wf_2",
      version: "1",
      ms: 1,
      llm_calls: 0,
      cents: 0,
      ok: 1,
      created_at: dayB,
      payload: JSON.stringify({
        tokenClasses: { compiled: 0, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 8 },
      }),
    });
    const frozen = dcWindowFromReceipts(store.receipts(), 3, dayB);
    expect(frozen.days.map((d) => d.day)).toEqual(["2026-08-18", "2026-08-19", "2026-08-20"]);
    expect(frozen.days[0]).toMatchObject({ measured: false, dcPct: 0 });
    const mid = frozen.days[1]!;
    expect(mid.measured).toBe(true);
    expect(mid.classes).toEqual({
      compiled: 15,
      memoized: 0,
      transparent: 0,
      steeredSkip: 5,
      frontier: 10,
      providerCache: 500,
    });
    expect(mid.dcPct).toBe(dcPct(mid.classes));
    expect(dcShare(mid.classes)).toBe(20 / 30);
    expect(frozen.days[2]).toMatchObject({ measured: true, dcPct: 0 });
    expect(frozen.current).toEqual({ dcPct: 0, measured: true });
  });
});
