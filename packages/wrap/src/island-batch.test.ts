import { describe, expect, test } from "bun:test";
import { unwrapIsland } from "@eden/ir";
import { islandBatchUrl, PROVIDER_BATCH_CENTS, canUseProviderBatch, withIslandBatch } from "./island-batch";
import { openaiIsland } from "./island";

function fakeProvider(calls: { chat: number; batch: number; bodies: unknown[] }, opts: { batchStatus?: number } = {}): typeof fetch {
  const fn = async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("messages/batches")) {
      calls.batch++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.bodies.push(body);
      if (opts.batchStatus && opts.batchStatus >= 400) return new Response("nope", { status: opts.batchStatus });
      const requests = (body.requests ?? []) as Array<{
        custom_id: string;
        params: { messages?: Array<{ content?: string }>; stream?: boolean };
      }>;
      return new Response(
        JSON.stringify({
          processing_status: "ended",
          results: requests.map((r) => ({
            custom_id: r.custom_id,
            result: {
              type: "succeeded",
              message: {
                content: [{ type: "text", text: JSON.stringify({ id: JSON.parse(String(r.params.messages?.[0]?.content ?? "{}")).id }) }],
                usage: { input_tokens: 8, output_tokens: 2 },
              },
            },
          })),
        }),
        { status: 200 },
      );
    }
    calls.chat++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const user = JSON.parse(body.messages[1].content);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ id: user.id }) } }],
        usage: { prompt_tokens: 8, completion_tokens: 2 },
      }),
      { status: 200 },
    );
  };
  return fn as typeof fetch;
}

describe("island batch transport", () => {
  test("PROVIDER_BATCH_CENTS is the provider contract (half of sync)", () => {
    expect(PROVIDER_BATCH_CENTS).toBe(0.5);
  });

  test("islandBatchUrl matches Message Batches path", () => {
    expect(islandBatchUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/messages/batches");
  });

  test("custom_id rejoins results; stream is false on the batch path", async () => {
    const calls = { chat: 0, batch: 0, bodies: [] as unknown[] };
    const fetchFn = fakeProvider(calls);
    const island = withIslandBatch(openaiIsland({ fetch: fetchFn }), { fetch: fetchFn });
    const [a, b] = await Promise.all([
      island({ system: "s", input: { id: "A" }, outputSchema: {}, wait: true }),
      island({ system: "s", input: { id: "B" }, outputSchema: {}, wait: true }),
    ]);
    expect(calls.batch).toBe(1);
    const body = calls.bodies[0] as { requests: Array<{ custom_id: string; params: { stream: boolean } }> };
    expect(body.requests.map((r) => r.custom_id)).toEqual(["0", "1"]);
    expect(body.requests.every((r) => r.params.stream === false)).toBe(true);
    expect(unwrapIsland(a).value).toEqual({ id: "A" });
    expect(unwrapIsland(b).value).toEqual({ id: "B" });
    expect(unwrapIsland(a).usage?.batched).toBe(true);
  });

  test("missing result row fails that item open to sync", async () => {
    const calls = { chat: 0, batch: 0 };
    const fetchFn: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("messages/batches")) {
        calls.batch++;
        const body = JSON.parse(String(init?.body ?? "{}"));
        const first = body.requests[0];
        return new Response(
          JSON.stringify({
            results: [
              {
                custom_id: first.custom_id,
                result: {
                  type: "succeeded",
                  message: {
                    content: [{ type: "text", text: JSON.stringify({ id: "only" }) }],
                    usage: { input_tokens: 1, output_tokens: 1 },
                  },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      calls.chat++;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ id: "sync" }) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const island = withIslandBatch(openaiIsland({ fetch: fetchFn }), { fetch: fetchFn });
    const [a, b] = await Promise.all([
      island({ system: "s", input: { id: "A" }, outputSchema: {}, wait: true }),
      island({ system: "s", input: { id: "B" }, outputSchema: {}, wait: true }),
    ]);
    expect(calls.batch).toBe(1);
    expect(calls.chat).toBe(1);
    expect(unwrapIsland(a).usage?.batched).toBe(true);
    expect(unwrapIsland(b).usage?.batched).toBeUndefined();
    expect(unwrapIsland(b).value).toEqual({ id: "sync" });
  });

  test("caller abort during coalesce never hangs and never POSTs a batch", async () => {
    const calls = { chat: 0, batch: 0, bodies: [] as unknown[] };
    const fetchFn = fakeProvider(calls);
    const island = withIslandBatch(openaiIsland({ fetch: fetchFn }), { fetch: fetchFn, coalesceMs: 30 });
    const ac = new AbortController();
    const p = island({ system: "s", input: { id: "A" }, outputSchema: {}, wait: true, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
    await Bun.sleep(40);
    expect(calls.batch).toBe(0);
    expect(calls.chat).toBe(0);
  });

  test("default OpenAI and Anthropic hosts without an injected fetch do not POST /messages/batches", () => {
    expect(canUseProviderBatch({ baseURL: "https://api.openai.com/v1" })).toBe(false);
    expect(canUseProviderBatch({ baseURL: "https://api.anthropic.com/v1" })).toBe(false);
    expect(canUseProviderBatch({ baseURL: "https://proxy.internal/v1" })).toBe(true);
    const injected = fakeProvider({ chat: 0, batch: 0, bodies: [] });
    expect(canUseProviderBatch({ baseURL: "https://api.openai.com/v1", fetch: injected })).toBe(true);
    expect(canUseProviderBatch({ baseURL: "https://api.anthropic.com/v1", fetch: injected })).toBe(true);
  });

  test("in_progress CREATE then retrieve inside the island timeout is half cents, zero sync", async () => {
    const calls = { chat: 0, batch: 0, get: 0 };
    let gets = 0;
    const fetchFn: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? "GET").toUpperCase();
      if (u.includes("messages/batches") && method === "POST") {
        calls.batch++;
        return new Response(JSON.stringify({ id: "msgbatch_poll", processing_status: "in_progress" }), { status: 200 });
      }
      if (u.includes("messages/batches/msgbatch_poll") && method === "GET") {
        calls.get++;
        gets++;
        if (gets < 2) {
          return new Response(JSON.stringify({ id: "msgbatch_poll", processing_status: "in_progress" }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "msgbatch_poll",
            processing_status: "ended",
            results: [
              {
                custom_id: "0",
                result: {
                  type: "succeeded",
                  message: { content: [{ type: "text", text: JSON.stringify({ id: "A" }) }], usage: { input_tokens: 8, output_tokens: 2 } },
                },
              },
              {
                custom_id: "1",
                result: {
                  type: "succeeded",
                  message: { content: [{ type: "text", text: JSON.stringify({ id: "B" }) }], usage: { input_tokens: 8, output_tokens: 2 } },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      calls.chat++;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ id: "sync" }) } }] }), { status: 200 });
    }) as typeof fetch;
    const island = withIslandBatch(openaiIsland({ fetch: fetchFn }), { fetch: fetchFn });
    const [a, b] = await Promise.all([
      island({ system: "s", input: { id: "A" }, outputSchema: {}, wait: true }),
      island({ system: "s", input: { id: "B" }, outputSchema: {}, wait: true }),
    ]);
    expect(calls.batch).toBe(1);
    expect(calls.chat).toBe(0);
    expect(calls.get).toBeGreaterThanOrEqual(2);
    expect(unwrapIsland(a).usage?.batched).toBe(true);
    expect(unwrapIsland(b).usage?.batched).toBe(true);
    expect(unwrapIsland(a).value).toEqual({ id: "A" });
    expect(unwrapIsland(b).value).toEqual({ id: "B" });
  });

  test("in_progress CREATE with no retrieve fails open to sync without hanging", async () => {
    const calls = { chat: 0, batch: 0 };
    const fetchFn: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? "GET").toUpperCase();
      if (u.includes("messages/batches") && method === "POST") {
        calls.batch++;
        return new Response(JSON.stringify({ id: "msgbatch_stuck", processing_status: "in_progress" }), { status: 200 });
      }
      if (u.includes("messages/batches") && method === "GET") {
        return new Response("not found", { status: 404 });
      }
      calls.chat++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const user = JSON.parse(body.messages[1].content);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ id: user.id }) } }],
          usage: { prompt_tokens: 8, completion_tokens: 2 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const island = withIslandBatch(openaiIsland({ fetch: fetchFn }), { fetch: fetchFn });
    const t0 = performance.now();
    const [a, b] = await Promise.all([
      island({ system: "s", input: { id: "A" }, outputSchema: {}, wait: true }),
      island({ system: "s", input: { id: "B" }, outputSchema: {}, wait: true }),
    ]);
    const wall = performance.now() - t0;
    expect(calls.batch).toBe(1);
    expect(calls.chat).toBe(2);
    expect(unwrapIsland(a).usage?.batched).toBeUndefined();
    expect(unwrapIsland(b).value).toEqual({ id: "B" });
    expect(wall).toBeLessThan(500);
  });
});
