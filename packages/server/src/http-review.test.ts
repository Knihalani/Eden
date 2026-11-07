/**
 * A24's review of A14 (D325, D326). Routes that read a frozen user's items thaw them through `partner.ready` first, so
 * the thaw runs in slices and other users' requests do not wait behind it; routes that read no item leave them frozen.
 * A router's fan-out copy spends no rate token and is not counted, and only a router child honours its header.
 */
import { expect, test } from "bun:test";
import { ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { StaticSource } from "@eden/sources";
import { createHandler } from "./http";

const key = "k_acme_0123456789abcdef";

test("/v1/pending and a source's /v1/forget thaw through ready; a whole forget and session_end read nothing", async () => {
  const crm = new StaticSource("crm", "deals", [
    { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off the Globex renewal" },
    { ref: "d2", title: "Initech renewal", text: "Initech asked for net 60 on the renewal" },
  ]);
  const cache = new ItemCache({ freezeIdleMs: 1, expireEveryMs: 1 });
  cache.close(); // The test runs the expiry ticks.
  let queued = 0;
  const real = cache.ready.bind(cache);
  cache.ready = (scope) => {
    const p = real(scope);
    if (p) queued++;
    return p;
  };
  const clock = Date.UTC(2026, 10, 7, 9);
  const partner = new ContextPartner({
    sources: async () => [crm],
    sourceMap: new SourceMap(),
    cache,
    budget: new Budget(),
    model: null,
    now: () => clock,
  });
  const handle = createHandler(partner, { keys: new Map([[key, "acme"]]), dev: false });
  const post = (path: string, body: unknown) =>
    handle(
      new Request(`http://x${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const scope = { tenantId: "acme", userId: "u1" };
  const freeze = () => {
    cache.expireIdle(clock);
    cache.expireIdle(clock);
    expect(cache.frozenCount).toBe(1);
  };
  expect(
    (await post("/v1/ask", { userId: "u1", sessionId: "s1", question: "what about the Globex renewal?" })).status,
  ).toBe(200);
  expect(cache.revision(scope)).toBeGreaterThan(0);

  freeze();
  expect((await post("/v1/events", { userId: "u1", sessionId: "s1", kind: "session_end", at: clock })).status).toBe(
    200,
  );
  const draft = { userId: "u1", sessionId: "s2", kind: "user_message", text: "Globex", draft: true, at: clock };
  expect((await post("/v1/events", draft)).status).toBe(200);
  expect(cache.frozenCount).toBe(1);
  expect(queued).toBe(0);

  expect((await post("/v1/pending", { userId: "u1", sessionId: "s1" })).status).toBe(200);
  expect(queued).toBe(1);
  expect(cache.frozenCount).toBe(0);

  freeze();
  expect((await post("/v1/forget", { userId: "u1", sourceId: "crm" })).status).toBe(200);
  expect(queued).toBe(2);

  await post("/v1/ask", { userId: "u1", sessionId: "s1", question: "what about the Globex renewal?" });
  freeze();
  const before = queued;
  expect((await post("/v1/forget", { userId: "u1" })).status).toBe(200);
  expect(queued).toBe(before);
  expect(cache.frozenCount).toBe(0);
});

test("a router's fan-out copy spends no rate token and is not counted, in a router child only (A24)", async () => {
  const crm = new StaticSource("crm", "deals", [{ ref: "d1", title: "Globex renewal", text: "Dana wants 12% off" }]);
  const partner = new ContextPartner({
    sources: async () => [crm],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
  });
  const keys = new Map([[key, "acme"]]);
  // A burst of one and no refill to speak of: the second request a tenant makes is limited.
  const limits = { keys, dev: false, tenantRatePerSec: 1e-6, tenantBurst: 1 };
  const usage = async (handle: ReturnType<typeof createHandler>, copy: boolean) =>
    handle(
      new Request("http://x/v1/usage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          ...(copy ? { "x-eden-fanout-copy": "1" } : {}),
        },
        body: "{}",
      }),
    );
  const child = createHandler(partner, { ...limits, child: { index: 1, count: 4 } });
  expect((await usage(child, false)).status).toBe(200); // The owner's copy spends the one token.
  for (let i = 0; i < 3; i++) expect((await usage(child, true)).status).toBe(200);
  const counted = (await (await usage(child, true)).json()) as { requests: Record<string, number> };
  expect(counted.requests.usage).toBe(1);
  expect((await usage(child, false)).status).toBe(429);
  // On a route the router never copies, the header is a caller's own: limited like any request.
  const ask = await child(
    new Request("http://x/v1/ask", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-eden-fanout-copy": "1" },
      body: JSON.stringify({ userId: "u1", sessionId: "s1", question: "Globex?" }),
    }),
  );
  expect(ask.status).toBe(429);
  // In a single process the header is a caller's own and means nothing.
  const single = createHandler(partner, limits);
  expect((await usage(single, false)).status).toBe(200);
  expect((await usage(single, true)).status).toBe(429);
});
