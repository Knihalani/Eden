import { expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { ContextPartner, ItemCache } from "@eden/engine";
import { turnGateNotice } from "./build";
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
