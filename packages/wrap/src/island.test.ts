import { describe, expect, test } from "bun:test";
import { IslandReply, unwrapIsland, type StretchProgram } from "@eden/ir";
import { registryFrom, runProgram } from "@eden/runtime";
import { eden } from "./eden";
import {
  createWitnessTable,
  islandMemoKey,
  openaiIsland,
  wrapIsland,
  withIslandBatch,
  withWitnessMemo,
} from "./island";

function fakeFetch(calls: { n: number }, latencyMs = 0): typeof fetch {
  const fn = async (_url: unknown, init: RequestInit) => {
    calls.n++;
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    const body = JSON.parse(String(init.body));
    const user = JSON.parse(body.messages[1].content);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ owner: user.repos?.[0]?.split("/")[0] ?? "?" }) } }] }),
      { status: 200 },
    );
  };
  return fn as typeof fetch;
}

function fakeProvider(calls: { chat: number; batch: number }, opts: { batchStatus?: number } = {}): typeof fetch {
  const fn = async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("messages/batches")) {
      calls.batch++;
      if (opts.batchStatus && opts.batchStatus >= 400) return new Response("nope", { status: opts.batchStatus });
      const body = JSON.parse(String(init?.body ?? "{}"));
      const requests = (body.requests ?? []) as Array<{
        custom_id: string;
        params: { messages?: Array<{ content?: string }> };
      }>;
      return new Response(
        JSON.stringify({
          id: "msgbatch_test",
          processing_status: "ended",
          results: requests.map((r) => {
            const user = JSON.parse(String(r.params.messages?.[0]?.content ?? "{}"));
            const owner = String(user.repos?.[0] ?? user.id ?? "?").split("/")[0];
            return {
              custom_id: r.custom_id,
              result: {
                type: "succeeded",
                message: {
                  content: [{ type: "text", text: JSON.stringify({ owner }) }],
                  usage: { input_tokens: 11, output_tokens: 4 },
                },
              },
            };
          }),
        }),
        { status: 200 },
      );
    }
    calls.chat++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    const user = JSON.parse(body.messages[1].content);
    const owner = String(user.repos?.[0] ?? user.id ?? "?").split("/")[0];
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ owner }) } }],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      }),
      { status: 200 },
    );
  };
  return fn as typeof fetch;
}

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

function twoIslandProgram(): StretchProgram {
  return {
    id: "p_islands",
    version: "1",
    name: "two_islands",
    description: "independent islands",
    inputSchema: { type: "object" },
    steps: [
      { id: "a", kind: "island", input: { kind: "input", path: "left" }, system: "s", outputSchema: { type: "object" } },
      { id: "b", kind: "island", input: { kind: "input", path: "right" }, system: "s", outputSchema: { type: "object" } },
    ],
    returns: { kind: "from", step: "b", path: "" },
    contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
    manifest: null,
  };
}

function oneIslandProgram(): StretchProgram {
  return {
    id: "p_one",
    version: "1",
    name: "one_island",
    description: "lone island",
    inputSchema: { type: "object" },
    steps: [{ id: "a", kind: "island", input: { kind: "input", path: "left" }, system: "s", outputSchema: { type: "object" } }],
    returns: { kind: "from", step: "a", path: "" },
    contract: { witnesses: 1, minLlmReduction: 5, allowExact: true },
    manifest: null,
  };
}

describe("deterministic-first islands", () => {
  test("identical input twice is served from witnesses forever after; unseen input falls back", async () => {
    const calls = { n: 0 };
    const base = openaiIsland({ fetch: fakeFetch(calls) });
    const fast = withWitnessMemo(base);
    const req = { system: "s", input: { repos: ["acme/app"] }, outputSchema: {} } as never;

    const r1 = await fast(req); // miss → live call
    const r2 = await fast(req); // seen=2 now
    const before = calls.n;
    const r3 = await fast(req); // served from memo

    expect(unwrapIsland(r1).value).toEqual({ owner: "acme" });
    expect(unwrapIsland(r2).value).toEqual({ owner: "acme" });
    expect(unwrapIsland(r3).value).toEqual({ owner: "acme" });
    expect(unwrapIsland(r3).usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, memoized: true });
    expect(calls.n - before).toBe(0);

    await fast({ system: "s", input: { repos: ["other/x"] }, outputSchema: {} } as never);
    expect(calls.n).toBeGreaterThan(before); // fallback still reaches the model
  });

  test("disagreeing outputs reset the evidence count instead of poisoning the table", () => {
    const t = createWitnessTable();
    const k = islandMemoKey({ system: "s", input: 1, outputSchema: {} });
    t.observe(k, { a: 1 });
    expect(t.lookup(k)).toBeUndefined();
    t.observe(k, { a: 1 });
    expect(t.lookup(k)).toEqual({ a: 1 });
    t.observe(k, { a: 2 }); // contradiction
    expect(t.lookup(k)).toBeUndefined(); // evidence reset, not stale answer
    t.observe(k, { a: 2 });
    expect(t.lookup(k)).toEqual({ a: 2 });
  });

  test("different schemas/inputs never share an entry", async () => {
    const calls = { n: 0 };
    const base = openaiIsland({ fetch: fakeFetch(calls) });
    const fast = withWitnessMemo(base);
    await fast({ system: "s", input: { repos: ["o/r"] }, outputSchema: {} } as never);
    await fast({ system: "s", input: { repos: ["o/r"] }, outputSchema: {} } as never);
    const before = calls.n;
    await fast({ system: "s2", input: { repos: ["o/r"] }, outputSchema: {} } as never);
    expect(calls.n).toBe(before + 1);
  });
});

describe("openaiIsland scrapes provider usage", () => {
  test("returns IslandReply with parseUsage + parseCacheTokens", async () => {
    const fn = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ owner: "acme" }) } }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        }),
        { status: 200 },
      );
    const island = openaiIsland({ fetch: fn as typeof fetch });
    const out = await island({ system: "s", input: { repos: ["acme/app"] }, outputSchema: {} });
    expect(out).toBeInstanceOf(IslandReply);
    expect(unwrapIsland(out)).toEqual({
      value: { owner: "acme" },
      usage: { prompt_tokens: 11, completion_tokens: 4, cached_tokens: 3, cache_input_tokens: 11 },
    });
  });
});

describe("island-miss batching", () => {
  test("two independent waitable misses share one batch; usage.batched and full tokens", async () => {
    const calls = { chat: 0, batch: 0 };
    const island = wrapIsland({ apiKey: "sk-test", fetch: fakeProvider(calls) });
    const [left, right] = await Promise.all([
      island!({ system: "s", input: { repos: ["acme/app"] }, outputSchema: {}, wait: true }),
      island!({ system: "s", input: { repos: ["beta/app"] }, outputSchema: {}, wait: true }),
    ]);
    expect(calls.batch).toBe(1);
    expect(calls.chat).toBe(0);
    const a = unwrapIsland(left);
    const b = unwrapIsland(right);
    expect(a.value).toEqual({ owner: "acme" });
    expect(b.value).toEqual({ owner: "beta" });
    expect(a.usage?.batched).toBe(true);
    expect(b.usage?.batched).toBe(true);
    expect(a.usage?.prompt_tokens).toBe(11);
    expect(a.usage?.completion_tokens).toBe(4);
    expect(b.usage?.prompt_tokens).toBe(11);
    expect(b.usage?.memoized).toBeUndefined();
  });

  test("lone waitable miss (n=1) stays on the sync path", async () => {
    const calls = { chat: 0, batch: 0 };
    const island = wrapIsland({ apiKey: "sk-test", fetch: fakeProvider(calls) });
    const out = await island!({ system: "s", input: { repos: ["acme/app"] }, outputSchema: {}, wait: true });
    expect(calls.batch).toBe(0);
    expect(calls.chat).toBe(1);
    expect(unwrapIsland(out).usage?.batched).toBeUndefined();
    expect(unwrapIsland(out).value).toEqual({ owner: "acme" });
  });

  test("EDEN_ISLAND_BATCH=0 forces sync even when waitable siblings exist", async () => {
    const prev = process.env.EDEN_ISLAND_BATCH;
    process.env.EDEN_ISLAND_BATCH = "0";
    try {
      const calls = { chat: 0, batch: 0 };
      const island = wrapIsland({ apiKey: "sk-test", fetch: fakeProvider(calls) });
      await Promise.all([
        island!({ system: "s", input: { repos: ["acme/app"] }, outputSchema: {}, wait: true }),
        island!({ system: "s", input: { repos: ["beta/app"] }, outputSchema: {}, wait: true }),
      ]);
      expect(calls.batch).toBe(0);
      expect(calls.chat).toBe(2);
    } finally {
      restoreEnv("EDEN_ISLAND_BATCH", prev);
    }
  });

  test("pinned miss never fetches and never joins a batch", async () => {
    const calls = { chat: 0, batch: 0 };
    const island = wrapIsland({ apiKey: "sk-test", fetch: fakeProvider(calls) });
    await expect(
      island!({ system: "s", input: { repos: ["acme/app"] }, outputSchema: {}, pinned: true, wait: true }),
    ).rejects.toThrow(/pinned island miss/);
    expect(calls.chat).toBe(0);
    expect(calls.batch).toBe(0);
  });

  test("memo hit never joins a batch", async () => {
    const calls = { chat: 0, batch: 0 };
    const island = wrapIsland({ apiKey: "sk-test", fetch: fakeProvider(calls) });
    const req = { system: "s", input: { repos: ["acme/app"] }, outputSchema: {} };
    await island!(req);
    await island!(req);
    const before = { chat: calls.chat, batch: calls.batch };
    const hit = await island!({ ...req, wait: true });
    expect(unwrapIsland(hit).usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, memoized: true });
    expect(unwrapIsland(hit).usage?.batched).toBeUndefined();
    expect(calls.chat).toBe(before.chat);
    expect(calls.batch).toBe(before.batch);
  });

  test("runProgram: memo hit cents are 0, not a billed island unit", async () => {
    const calls = { chat: 0, batch: 0 };
    const island = wrapIsland({ apiKey: "sk-test", fetch: fakeProvider(calls) });
    const input = { left: { repos: ["acme/app"] } };
    const opts = { registry: registryFrom({}), island: island!, llmCents: 1, checkEnvelope: false as const };
    const miss = await runProgram(oneIslandProgram(), input, opts);
    expect(miss.stats.cents).toBe(1);
    await runProgram(oneIslandProgram(), input, opts);
    const hit = await runProgram(oneIslandProgram(), input, opts);
    expect(hit.stats.cents).toBe(0);
    expect(hit.stats.islandMemoized).toBe(true);
    expect(hit.stats.islandPromptTokens).toBe(0);
    expect(calls.batch).toBe(0);
  });

  test("batch transport error fails open to sync", async () => {
    const calls = { chat: 0, batch: 0 };
    const island = wrapIsland({ apiKey: "sk-test", fetch: fakeProvider(calls, { batchStatus: 500 }) });
    const [left, right] = await Promise.all([
      island!({ system: "s", input: { repos: ["acme/app"] }, outputSchema: {}, wait: true }),
      island!({ system: "s", input: { repos: ["beta/app"] }, outputSchema: {}, wait: true }),
    ]);
    expect(calls.batch).toBe(1);
    expect(calls.chat).toBe(2);
    expect(unwrapIsland(left).usage?.batched).toBeUndefined();
    expect(unwrapIsland(right).usage?.batched).toBeUndefined();
    expect(unwrapIsland(left).value).toEqual({ owner: "acme" });
    expect(unwrapIsland(right).value).toEqual({ owner: "beta" });
  });

  test("runProgram: two independent misses are cheaper on the batch path; tokens stay full", async () => {
    const input = { left: { repos: ["acme/app"] }, right: { repos: ["beta/app"] } };
    const registry = registryFrom({});
    const llmCents = 1;

    const syncCalls = { chat: 0, batch: 0 };
    const sync = await runProgram(twoIslandProgram(), input, {
      registry,
      island: withWitnessMemo(openaiIsland({ fetch: fakeProvider(syncCalls) })),
      llmCents,
      checkEnvelope: false,
    });
    const syncCents = sync.stats.cents;
    const syncPrompt = sync.stats.islandPromptTokens;
    const syncCompletion = sync.stats.islandCompletionTokens;
    expect(syncCalls.batch).toBe(0);
    expect(syncCalls.chat).toBe(2);
    expect(sync.stats.llmCalls).toBe(2);

    const batchCalls = { chat: 0, batch: 0 };
    const batched = await runProgram(twoIslandProgram(), input, {
      registry,
      island: wrapIsland({ apiKey: "sk-test", fetch: fakeProvider(batchCalls) }),
      llmCents,
      checkEnvelope: false,
    });
    expect(batchCalls.batch).toBe(1);
    expect(batchCalls.chat).toBe(0);
    expect(syncCents).toBe(2);
    expect(batched.stats.cents).toBe(syncCents * 0.5);
    expect(batched.stats.cents).toBe(1);
    expect(batched.stats.islandPromptTokens).toBe(syncPrompt);
    expect(batched.stats.islandCompletionTokens).toBe(syncCompletion);
    expect(batched.stats.islandPromptTokens).toBe(22);
    expect(batched.stats.islandCompletionTokens).toBe(8);
  });

  test("runProgram: in_progress then retrieve still bills half cents on the same tokens", async () => {
    let gets = 0;
    const calls = { chat: 0, batch: 0 };
    const fetchFn: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = String(init?.method ?? "GET").toUpperCase();
      if (u.includes("messages/batches") && method === "POST") {
        calls.batch++;
        return new Response(JSON.stringify({ id: "msgbatch_cents", processing_status: "in_progress" }), { status: 200 });
      }
      if (u.includes("messages/batches/msgbatch_cents") && method === "GET") {
        gets++;
        if (gets < 2) {
          return new Response(JSON.stringify({ id: "msgbatch_cents", processing_status: "in_progress" }), { status: 200 });
        }
        const mk = (custom_id: string, owner: string) => ({
          custom_id,
          result: {
            type: "succeeded",
            message: {
              content: [{ type: "text", text: JSON.stringify({ owner }) }],
              usage: { input_tokens: 11, output_tokens: 4 },
            },
          },
        });
        return new Response(
          JSON.stringify({
            id: "msgbatch_cents",
            processing_status: "ended",
            results: [mk("0", "acme"), mk("1", "beta")],
          }),
          { status: 200 },
        );
      }
      calls.chat++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 });
    }) as typeof fetch;
    const out = await runProgram(
      twoIslandProgram(),
      { left: { repos: ["acme/app"] }, right: { repos: ["beta/app"] } },
      { registry: registryFrom({}), island: wrapIsland({ apiKey: "sk-test", fetch: fetchFn })!, llmCents: 1, checkEnvelope: false },
    );
    expect(calls.batch).toBe(1);
    expect(calls.chat).toBe(0);
    expect(out.stats.cents).toBe(1);
    expect(out.stats.islandPromptTokens).toBe(22);
    expect(out.stats.islandCompletionTokens).toBe(8);
  });

  test("runProgram: a lone blocking island stays sync (full cents)", async () => {
    const calls = { chat: 0, batch: 0 };
    const out = await runProgram(oneIslandProgram(), { left: { repos: ["acme/app"] } }, {
      registry: registryFrom({}),
      island: wrapIsland({ apiKey: "sk-test", fetch: fakeProvider(calls) }),
      llmCents: 1,
      checkEnvelope: false,
    });
    expect(calls.batch).toBe(0);
    expect(calls.chat).toBe(1);
    expect(out.stats.cents).toBe(1);
    expect(out.stats.islandPromptTokens).toBe(11);
  });

  test("runProgram: pinned island miss never fetches", async () => {
    const calls = { chat: 0, batch: 0 };
    const program: StretchProgram = {
      ...oneIslandProgram(),
      steps: [{ id: "a", kind: "island", input: { kind: "literal", value: { repos: ["x/y"] } }, system: "s", outputSchema: { type: "object" }, pinned: true }],
    };
    await expect(
      runProgram(program, {}, {
        registry: registryFrom({}),
        island: wrapIsland({ apiKey: "sk-test", fetch: fakeProvider(calls) }),
        checkEnvelope: false,
      }),
    ).rejects.toThrow(/pinned island miss/);
    expect(calls.chat).toBe(0);
    expect(calls.batch).toBe(0);
  });

  test("withIslandBatch n=1 after coalesce does not POST batches", async () => {
    const calls = { chat: 0, batch: 0 };
    const island = withIslandBatch(openaiIsland({ fetch: fakeProvider(calls) }), { fetch: fakeProvider(calls) });
    const out = await island({ system: "s", input: { repos: ["acme/app"] }, outputSchema: {}, wait: true });
    expect(calls.batch).toBe(0);
    expect(calls.chat).toBe(1);
    expect(unwrapIsland(out).usage?.batched).toBeUndefined();
  });

  test("eden() default island is wrapIsland: waitable misses share a batch", async () => {
    const calls = { chat: 0, batch: 0 };
    const e = eden({ apiKey: "sk-test", fetch: fakeProvider(calls) });
    const island = e.state.opts.island;
    expect(island).toBeDefined();
    await Promise.all([
      island!({ system: "s", input: { repos: ["acme/app"] }, outputSchema: {}, wait: true }),
      island!({ system: "s", input: { repos: ["beta/app"] }, outputSchema: {}, wait: true }),
    ]);
    expect(calls.batch).toBe(1);
    expect(calls.chat).toBe(0);
  });
});
