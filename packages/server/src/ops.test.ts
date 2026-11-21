import { expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, type ChatResponse, type Model } from "@eden/llm";
import { ContextPartner, ItemCache } from "@eden/engine";
import { countedModel, modelCache, modelFailures, readerFailureLog, turnGateNotice } from "./build";
import { clusterKeyMatches, Ops, serveError, sumMetrics } from "./ops";

const KEY = "cluster-key-0123456789abcdef";

function ops() {
  const cache = new ItemCache();
  cache.close();
  const partner = new ContextPartner({
    sources: async () => [],
    sourceMap: new SourceMap(":memory:"),
    cache,
    budget: new Budget(),
    model: null,
  });
  return new Ops(partner, null, { clusterKey: KEY, child: { index: 0, count: 1 }, releaseMs: 1_000 });
}

test("readiness turns 503 while draining; liveness is the handler's own (D994)", async () => {
  const o = ops();
  const handler = o.wrap(() => new Response("api"));
  expect((await handler(new Request("http://x/readyz"))).status).toBe(200);
  o.draining = true;
  const r = await handler(new Request("http://x/readyz"));
  expect([r.status, await r.json()]).toEqual([503, { ready: false, error: "draining" }]);
  expect(await (await handler(new Request("http://x/healthz"))).text()).toBe("api");
});

test("metrics count requests by known route and status, never a caller's path, with users held (D994)", async () => {
  const o = ops();
  const handler = o.wrap((req) => new Response(null, { status: new URL(req.url).pathname === "/v1/ask" ? 400 : 200 }));
  await handler(new Request("http://x/v1/events", { method: "POST" }));
  await handler(new Request("http://x/v1/ask", { method: "POST" }));
  await handler(new Request("http://x/acme/u1/secret-path"));
  const text = await (await handler(new Request("http://x/metrics"))).text();
  expect(text).toContain('eden_requests_total{route="/v1/events",status="200"} 1');
  expect(text).toContain('eden_requests_total{route="/v1/ask",status="400"} 1');
  expect(text).toContain('eden_requests_total{route="other",status="200"} 1');
  expect(text).not.toContain("secret-path");
  expect(text).toMatch(/^eden_users_held 0$/m);
  expect(text).toContain('eden_request_seconds_bucket{route="/v1/events",le="+Inf"} 1');
  // Every sample line is "name{labels} value", parseable as Prometheus text.
  for (const line of text.split("\n").filter((l) => l && !l.startsWith("#")))
    expect(line).toMatch(/^[a-z_]+(\{[^}]*\})? \S+$/);
});

test("model failures reach /metrics by role and kind, and sum across processes (D1690)", async () => {
  const o = ops();
  const handler = o.wrap(() => new Response("api"));
  const before = modelFailures["check:error"];
  readerFailureLog(() => {}, undefined, "check failed", "check")(new Error("openrouter 403"));
  const text = await (await handler(new Request("http://x/metrics"))).text();
  expect(text).toContain(`eden_model_failures_total{kind="error",role="check"} ${before + 1}`);
  expect(text).toMatch(/^eden_model_failures_total\{kind="unreadable",role="reader"\} \d+$/m);
  const summed = sumMetrics([text, text]);
  expect(summed).toContain(`eden_model_failures_total{kind="error",role="check"} ${2 * (before + 1)}`);
});

test("sumMetrics adds samples with the same name and labels, keeps the largest _max", () => {
  const a = '# TYPE eden_users_held gauge\neden_users_held 3\neden_uptime_seconds_max 10\nx{route="a"} 1\n';
  const b =
    '# TYPE eden_users_held gauge\neden_users_held 4\neden_uptime_seconds_max 7\nx{route="a"} 2\nx{route="b"} 5\n';
  expect(sumMetrics([a, b])).toBe(
    '# TYPE eden_users_held gauge\neden_users_held 7\neden_uptime_seconds_max 10\nx{route="a"} 3\nx{route="b"} 5\n',
  );
});

test("the membership route needs the cluster key, compared whole (D992)", async () => {
  const o = ops();
  const handler = o.wrap(() => new Response("api"));
  const post = (auth?: string, body = '{"self":"a","nodes":["a","b"]}') =>
    handler(
      new Request("http://x/internal/cluster", {
        method: "POST",
        headers: auth ? { authorization: auth } : {},
        body,
      }),
    );
  expect((await post()).status).toBe(401);
  expect((await post(`Bearer ${KEY}x`)).status).toBe(401);
  expect((await post(`Bearer ${KEY.slice(0, -1)}`)).status).toBe(401);
  expect((await post(`Bearer ${KEY}`, "{bad")).status).toBe(400);
  expect((await post(`Bearer ${KEY}`, '{"self":1}')).status).toBe(400);
  const ok = await post(`Bearer ${KEY}`);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ released: 0, written: 0, pending: 0 });
  expect(clusterKeyMatches(undefined, new Request("http://x", { headers: { authorization: "Bearer " } }))).toBe(false);
});

test("a membership with more nodes than placement takes is a 400, and a throw in the fence is a 503, never a 500 (R1)", async () => {
  const o = ops();
  const handler = o.wrap(() => new Response("api"));
  const nodes = Array.from({ length: 40_000 }, (_, i) => `n${i}`);
  const r = await handler(
    new Request("http://x/internal/cluster", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ self: "n0", nodes }),
    }),
  );
  expect(r.status).toBe(400);
  const failing = o.wrap(() => {
    throw new Error("boom");
  });
  expect((await failing(new Request("http://x/v1/events", { method: "POST", body: "{}" }))).status).toBe(503);
});

test("a release that finishes after a newer drop does not put its older table back (R1)", async () => {
  const cache = new ItemCache();
  cache.close();
  const partner = new ContextPartner({
    sources: async () => [],
    sourceMap: new SourceMap(":memory:"),
    cache,
    budget: new Budget(),
    model: null,
  });
  // A shared disk whose hand-offs take a while: the release awaits it while the drop lands.
  const disk = {
    handOff: async () => {},
    forgetAbsent: () => {},
    backlog: 0,
    local: { dropWhere: () => {} },
    setWritable: () => {},
  };
  const o = new Ops(partner, disk as never, { clusterKey: KEY, child: { index: 0, count: 1 }, releaseMs: 50 });
  const release = o.cluster({ self: "a", nodes: ["a"], epoch: 5, mode: "release" });
  await o.cluster({ self: "a", nodes: ["b"], epoch: 6, mode: "drop" });
  await release;
  // Epoch 6 says machine "a" owns nothing.
  expect(o.machineOwns(0)).toBe(false);
  expect(o.machineOwns(1234)).toBe(false);
});

test("every server's error handler is the 503, never Bun's default 500 (R1)", async () => {
  const r = serveError();
  expect(r.status).toBe(503);
  expect(await r.json()).toEqual({ error: "temporarily unable to serve context" });
  // main.ts passes it to Bun.serve (an entry point, so read, not imported).
  const main = await Bun.file(new URL("./main.ts", import.meta.url)).text();
  expect(main).toMatch(/Bun\.serve\(\{[\s\S]*?error: serveError,/);
});

test("the turn gate's startup notice: said only when the gate is on and its weights could not be read (R1)", () => {
  expect(turnGateNotice(true, null)).toContain("turn-gate.bin could not be read");
  expect(turnGateNotice(true, {})).toBeNull();
  expect(turnGateNotice(false, null)).toBeNull();
});

test("the roles' prompt-cache use reaches /metrics by role, counted through the model they call (D1800)", async () => {
  const o = ops();
  const handler = o.wrap(() => new Response("api"));
  const before = { ...modelCache.check };
  const reply = (cacheBreakpoints?: number, write?: number): ChatResponse => ({
    text: "{}",
    usage: {
      inputTokens: 1_000,
      outputTokens: 5,
      cachedInputTokens: 600,
      ...(write ? { cacheWriteTokens: write } : {}),
    },
    costUsd: 0,
    model: "m",
    latencyMs: 0,
    ...(cacheBreakpoints ? { cacheBreakpoints } : {}),
  });
  const replies = [reply(2, 300), reply()];
  const inner: Model = { id: "m", chat: async () => replies.shift()! };
  const counted = countedModel(inner, "check");
  expect(counted.id).toBe("m");
  const request = { messages: [{ role: "user" as const, content: "x" }], maxTokens: 1 };
  expect((await counted.chat(request)).cacheBreakpoints).toBe(2);
  await counted.chat(request);
  const c = modelCache.check;
  expect(c.calls - before.calls).toBe(2);
  expect(c.breakpointCalls - before.breakpointCalls).toBe(1);
  expect(c.inputTokens - before.inputTokens).toBe(2_000);
  expect(c.cacheReadTokens - before.cacheReadTokens).toBe(1_200);
  expect(c.cacheWriteTokens - before.cacheWriteTokens).toBe(300);
  const text = await (await handler(new Request("http://x/metrics"))).text();
  expect(text).toContain(`eden_model_cache_breakpoint_calls_total{role="check"} ${c.breakpointCalls}`);
  expect(text).toContain(`eden_model_cache_read_tokens_total{role="check"} ${c.cacheReadTokens}`);
  for (const role of ["reader", "check", "cards"])
    for (const name of ["calls", "cache_breakpoint_calls", "input_tokens", "cache_read_tokens", "cache_write_tokens"])
      expect(text).toMatch(new RegExp(`^eden_model_${name}_total\\{role="${role}"\\} \\d+$`, "m"));
  expect(sumMetrics([text, text])).toContain(`eden_model_calls_total{role="check"} ${2 * c.calls}`);
});

test("the router's deadline stretches the node's release budget; the node reports how many it holds (S1-P6)", async () => {
  // A shared disk whose hand-offs take 200 ms; the node's own releaseMs is 50.
  const build = async () => {
    const cache = new ItemCache();
    cache.close();
    cache.put({ tenantId: "t", userId: "u1" }, [
      { id: "mail:d1", sourceId: "mail", ref: "d1", title: "t", text: "hello", updatedAt: 0 },
    ]);
    const partner = new ContextPartner({
      sources: async () => [],
      sourceMap: new SourceMap(":memory:"),
      cache,
      budget: new Budget(),
      model: null,
    });
    const disk = {
      handOff: async () => {
        await Bun.sleep(200);
      },
      forgetAbsent: () => {},
      backlog: 1,
      local: { dropWhere: () => {} },
      setWritable: () => {},
    };
    return new Ops(partner, disk as never, {
      clusterKey: KEY,
      child: { index: 0, count: 1 },
      releaseMs: 50,
    });
  };
  // The held count also rides /readyz: the cluster probe reads it to keep its move estimate fresh (S1-P6).
  const o1 = await build();
  const readyz = await o1.wrap(() => new Response("api"))(new Request("http://x/readyz"));
  expect((await readyz.json()).held).toBe(1);
  // nodes=["b"] with self "a": u1's bucket is no longer this machine's, so u1 moves.
  // No deadlineMs: the node's own releaseMs rules and the 200 ms hand-off is reported pending.
  const a1 = await o1.cluster({ self: "a", nodes: ["b"], epoch: 1, mode: "release" });
  expect(a1.released).toBe(1);
  expect(a1.pending).toBe(1);
  expect(a1.held).toBe(1);
  // deadlineMs=4,000: the budget becomes 4,000-2,000 = 2,000 and the same hand-off lands inside it.
  const o2 = await build();
  const a2 = await o2.cluster({ self: "a", nodes: ["b"], epoch: 1, mode: "release", deadlineMs: 4_000 });
  expect(a2.released).toBe(1);
  expect(a2.pending).toBe(0);
});
