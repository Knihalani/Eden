import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { handleApi } from "./api";
import { Store } from "./store";

const PREV_DEV = process.env.EDEN_DEV;
const PREV_DIGEST = process.env.EDEN_DIGEST;
process.env.EDEN_DEV = "1";
afterAll(() => {
  process.env.EDEN_DEV = PREV_DEV;
  if (PREV_DIGEST === undefined) delete process.env.EDEN_DIGEST;
  else process.env.EDEN_DIGEST = PREV_DIGEST;
});
afterEach(() => {
  if (PREV_DIGEST === undefined) delete process.env.EDEN_DIGEST;
  else process.env.EDEN_DIGEST = PREV_DIGEST;
});

const TOKEN = "k";
const AUTH = { authorization: "Bearer k" };

function ctx(store = new Store(":memory:")) {
  return { store, token: TOKEN };
}

async function api(store: Store, path: string, init?: RequestInit) {
  const req = new Request(`http://x${path}`, init);
  return handleApi(req, new URL(req.url), ctx(store));
}

describe("GET /v1/digest", () => {
  test("needs the same key as /v1/inbox", async () => {
    const res = await api(new Store(":memory:"), "/v1/digest");
    expect(res?.status).toBe(401);
  });

  test("returns 404 {off:true} when not opted in and never emails", async () => {
    delete process.env.EDEN_DIGEST;
    const res = await api(new Store(":memory:"), "/v1/digest", { headers: AUTH });
    expect(res?.status).toBe(404);
    const body = (await res!.json()) as { off?: boolean; mailed?: boolean };
    expect(body).toEqual({ off: true });
    expect(body.mailed).toBeUndefined();
  });

  test("opted-in empty workspace is honest zeros, mailed false", async () => {
    process.env.EDEN_DIGEST = "1";
    const res = await api(new Store(":memory:"), "/v1/digest", { headers: AUTH });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      off: boolean;
      mailed: boolean;
      compiled: number;
      runs: number;
      waiting: number;
      fails: number;
      tokensSaved: number;
      dcPct: number | null;
      text: string;
    };
    expect(body.off).toBe(false);
    expect(body.mailed).toBe(false);
    expect(body.compiled).toBe(0);
    expect(body.runs).toBe(0);
    expect(body.waiting).toBe(0);
    expect(body.fails).toBe(0);
    expect(body.tokensSaved).toBe(0);
    expect(body.dcPct).toBeNull();
    expect(body.text).toContain("0 programs");
    expect(body.text).toContain("Compiled runs 0");
    expect(body.text).toContain("Deterministic share —");
    expect(body.text).toContain("Tokens saved 0");
  });

  test("skip-only leftover empty tokenClasses is unmeasured dcPct, not fake 0%", async () => {
    process.env.EDEN_DIGEST = "1";
    const store = new Store(":memory:");
    store.putTool({
      id: "wf_skip",
      name: "skip",
      version: "v1",
      program: {
        id: "wf_skip",
        version: "v1",
        name: "skip",
        description: "",
        inputSchema: { type: "object" },
        steps: [],
        returns: { kind: "literal", value: null },
        contract: { witnesses: 0, minLlmReduction: 2, allowExact: false },
        sequence: ["Grep"],
      },
      state: "live",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    store.putReceipt({
      tool_id: "wf_skip",
      version: "v1",
      ms: 1,
      llm_calls: 0,
      cents: 0,
      ok: 1,
      payload: JSON.stringify({
        tokenClass: "steered-skip",
        tokenClasses: { compiled: 0, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 0 },
        skipped: ["Grep"],
      }),
    });
    const res = await api(store, "/v1/digest", { headers: AUTH });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { dcPct: number | null; text: string };
    expect(body.dcPct).toBeNull();
    expect(body.text).toContain("Deterministic share —");
    expect(body.text).not.toContain("Deterministic share 0%");
  });

  test("GET /v1/digest prints provider cache hit % from GET-shaped stamped denom", async () => {
    process.env.EDEN_DIGEST = "1";
    const store = new Store(":memory:");
    store.putTool({
      id: "wf_1",
      name: "notify",
      version: "v1",
      program: {
        id: "wf_1",
        version: "v1",
        name: "notify",
        description: "",
        inputSchema: { type: "object" },
        steps: [],
        returns: { kind: "literal", value: null },
        contract: { witnesses: 0, minLlmReduction: 2, allowExact: false },
        sequence: ["lookup"],
      },
      state: "live",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    store.putReceipt({
      tool_id: "wf_1",
      version: "v1",
      ms: 8,
      llm_calls: 1,
      cents: 0,
      ok: 1,
      payload: JSON.stringify({
        prompt_tokens: 50,
        cached_tokens: 100000,
        cache_write_tokens: 0,
        cache_input_tokens: 100_050,
        tokenClasses: { compiled: 58, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 0, providerCache: 100000 },
      }),
    });
    const res = await api(store, "/v1/digest", { headers: AUTH });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { cacheHitPct: number | null; dcPct: number | null; text: string };
    expect(body.cacheHitPct).toBe((100_000 / 100_050) * 100);
    expect(body.cacheHitPct).not.toBe((100_000 / 50) * 100);
    expect(body.dcPct).toBe(100);
    expect(body.text).toContain("provider cache hit % 100%");
    expect(body.text).toContain("Deterministic share 100%");
    expect(body.text).not.toMatch(/3 of 4 reads from cache/);
    expect(body.text).not.toMatch(/200000/);
  });

  test("seed live_notify does not inflate compiled or runs the way savings.live would", async () => {
    process.env.EDEN_DIGEST = "1";
    const store = new Store(":memory:");
    store.putTool({
      id: "live_notify",
      name: "notify",
      version: "v1",
      program: {
        id: "live_notify",
        version: "v1",
        name: "notify",
        description: "",
        inputSchema: { type: "object" },
        steps: [],
        returns: { kind: "literal", value: null },
        contract: { witnesses: 0, minLlmReduction: 2, allowExact: false },
        sequence: ["lookup"],
      },
      state: "live",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    store.putReceipt({
      tool_id: "live_notify",
      version: "v1",
      ms: 1,
      llm_calls: 0,
      cents: 0,
      ok: 1,
    });
    expect(store.savings().live).toBe(1);
    expect(store.savings().runs).toBe(1);
    const res = await api(store, "/v1/digest", { headers: AUTH });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { compiled: number; runs: number };
    expect(body.compiled).toBe(0);
    expect(body.runs).toBe(0);
  });
});
