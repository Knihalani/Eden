import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trace } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { FakeModel } from "@eden/llm";
import { StaticSource } from "@eden/sources";
import { buildPartner, startGatePool } from "./build";
import { loadConfig } from "./config";
import { createHandler } from "./http";

const key = "k_acme_0123456789abcdef";
const crm = new StaticSource("crm", "deals", [
  { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off the Globex renewal" },
]);
const partner = buildPartner({ sources: async () => [crm], model: null });
const handle = createHandler(partner, { keys: new Map([[key, "acme"]]), dev: false });
const post = (path: string, body: unknown, auth = key) =>
  handle(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const who = { userId: "u1", sessionId: "s1" };

describe("HTTP API", () => {
  test("auth: unknown key 401, another tenant 403", async () => {
    expect((await post("/v1/ask", { ...who, question: "x" }, "nope")).status).toBe(401);
    expect((await post("/v1/ask", { ...who, tenantId: "other", question: "x" })).status).toBe(403);
  });

  test("bad input is a 400 with a message, never a 500", async () => {
    for (const body of ["{not json", [], { ...who, kind: "bogus" }, { kind: "user_message" }]) {
      const res = await post("/v1/events", body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0);
    }
  });

  test("an event can wait for the slow path and returns its injection", async () => {
    const res = await post("/v1/events?waitMs=1000", {
      ...who,
      kind: "user_message",
      text: "Globex renewal with Dana Lee",
    });
    const body = (await res.json()) as { injection: { citations: { itemId: string }[] } | null };
    expect(body.injection?.citations[0]?.itemId).toBe("crm:d1");
  });

  test("ask answers with citations; pending and forget respond", async () => {
    const ask = (await (await post("/v1/ask", { ...who, question: "What does Dana Lee want?" })).json()) as any;
    expect(ask.citations[0].itemId).toBe("crm:d1");
    expect(await (await post("/v1/pending", who)).json()).toEqual({ injections: [] });
    expect((await post("/v1/forget", { userId: "u1" })).status).toBe(200);
  });
});

describe("input checks (review finding 12)", () => {
  test("ids are validated on every route and used must be a boolean", async () => {
    expect((await post("/v1/pending", { userId: "a/b", sessionId: "s" })).status).toBe(400);
    expect((await post("/v1/forget", { userId: "u#1" })).status).toBe(400);
    const bad = await post("/v1/feedback", { ...who, injectionId: "inj_1", used: "false" });
    expect(bad.status).toBe(400);
    const ok = await post("/v1/feedback", { ...who, injectionId: "inj_unknown", used: false });
    expect(await ok.json()).toEqual({ ok: true, applied: false });
  });

  test("dev mode rejects a wrong key instead of mapping it to tenant dev", async () => {
    const dev = createHandler(partner, { keys: new Map(), dev: true });
    const req = (auth?: string) =>
      new Request("http://x/v1/pending", {
        method: "POST",
        headers: auth ? { authorization: `Bearer ${auth}` } : {},
        body: JSON.stringify(who),
      });
    expect((await dev(req("typo-key"))).status).toBe(401);
    expect((await dev(req())).status).toBe(200);
  });
});

describe("per-tenant rate limit", () => {
  test("past the burst a tenant gets 429 with Retry-After; another tenant is unaffected", async () => {
    const keyB = "k_other_0123456789abcd";
    const limited = createHandler(partner, {
      keys: new Map([
        [key, "acme"],
        [keyB, "other"],
      ]),
      dev: false,
      tenantRatePerSec: 1,
      tenantBurst: 2,
    });
    const call = (auth: string) =>
      limited(
        new Request("http://x/v1/pending", {
          method: "POST",
          headers: { authorization: `Bearer ${auth}` },
          body: JSON.stringify(who),
        }),
      );
    expect((await call(key)).status).toBe(200);
    expect((await call(key)).status).toBe(200);
    const third = await call(key);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await call(keyB)).status).toBe(200);
  });
});

describe("loadConfig", () => {
  test("refuses to start without keys outside dev, and rejects short keys", () => {
    expect(() => loadConfig({})).toThrow(/EDEN_API_KEYS/);
    expect(() => loadConfig({ EDEN_API_KEYS: "acme:short" })).toThrow(/16\+/);
    expect(loadConfig({ EDEN_DEV: "1" }).dev).toBe(true);
    expect(() => loadConfig({ EDEN_API_KEYS: "a/b:0123456789abcdef" })).toThrow(/tenant/);
  });
});

describe("gate pool", () => {
  test("by default lookups go through the planner; its learning is per user and forget drops only theirs", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "eden-planner-")), "source-map.db");
    const traces: Trace[] = [];
    const p = buildPartner({
      sources: async () => [crm],
      model: null,
      sourceMapPath: path,
      onTrace: (t) => traces.push(t),
    });
    const h = createHandler(p, { keys: new Map([[key, "acme"]]), dev: false });
    const send = (route: string, body: unknown) =>
      h(
        new Request(`http://x${route}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    for (const userId of ["u1", "u2"]) {
      const ev = { userId, sessionId: "s1", kind: "user_message", text: "Where is the Globex renewal with Dana Lee?" };
      expect((await send("/v1/events?waitMs=1000", ev)).status).toBe(200);
    }
    // Traces carry the planner's content-free outcome: connector, shape names, counts.
    const plans = traces.flatMap((t) => t.plans ?? []);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(Object.keys(plan).sort()).toEqual(["calls", "found", "shapes", "sourceId"]);
    const arms = (userId: string) => new SourceMap(path).loadArms({ tenantId: "acme", userId }, "crm");
    expect(arms("u1").length).toBeGreaterThan(0);
    expect(arms("u2").length).toBeGreaterThan(0);
    expect((await send("/v1/forget", { userId: "u1" })).status).toBe(200);
    expect(arms("u1")).toEqual([]);
    expect(arms("u2").length).toBeGreaterThan(0);
  });

  test("EDEN_QUERY_PLANNER: on (serving) by default (D33), 0 turns it off, junk refused", () => {
    expect(loadConfig({ EDEN_DEV: "1" }).queryPlanner).toBe("serve");
    expect(loadConfig({ EDEN_DEV: "1", EDEN_QUERY_PLANNER: "0" }).queryPlanner).toBe("off");
    expect(loadConfig({ EDEN_DEV: "1", EDEN_QUERY_PLANNER: "" }).queryPlanner).toBe("serve");
    expect(loadConfig({ EDEN_DEV: "1", EDEN_QUERY_PLANNER: "1" }).queryPlanner).toBe("serve");
    expect(loadConfig({ EDEN_DEV: "1", EDEN_QUERY_PLANNER: "shadow" }).queryPlanner).toBe("shadow");
    expect(() => loadConfig({ EDEN_DEV: "1", EDEN_QUERY_PLANNER: "yes" })).toThrow(/EDEN_QUERY_PLANNER/);
  });

  test("EDEN_GATE_WORKERS: default 0 (gate on the loop), a count, junk refused", async () => {
    expect(loadConfig({ EDEN_DEV: "1" }).gateWorkers).toBe(0);
    expect(loadConfig({ EDEN_DEV: "1", EDEN_GATE_WORKERS: "2" }).gateWorkers).toBe(2);
    expect(() => loadConfig({ EDEN_DEV: "1", EDEN_GATE_WORKERS: "-1" })).toThrow(/EDEN_GATE_WORKERS/);
    expect(await startGatePool(0)).toBeUndefined();
  });

  test("a partner built with a pool redacts lookup results in it", async () => {
    const pool = (await startGatePool(1))!;
    try {
      const secret = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
      const big = new StaticSource("crm", "Deals", [
        { ref: "d1", title: "Globex renewal", text: `Globex renewal, Dana Lee, ${secret} ${"terms ".repeat(400)}` },
      ]);
      const pooled = buildPartner({ sources: async () => [big], model: null, gatePool: pool });
      const handle = createHandler(pooled, { keys: new Map(), dev: true });
      const res = await handle(
        new Request("http://x/v1/ask", {
          method: "POST",
          body: JSON.stringify({ userId: "u", sessionId: "s", question: "Globex renewal with Dana Lee?" }),
        }),
      );
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain("Globex renewal");
      expect(body).not.toContain(secret);
      expect(pool.stats().completed).toBeGreaterThan(0); // Over 1 KB: gated in the worker, not inline.
    } finally {
      pool.close();
    }
  });
});

describe("audit regressions (2026-10-29)", () => {
  test("a tool_call input nested past the stack limit is the caller's error: 400, not 503", async () => {
    const key = "k_acme_0123456789abcdef";
    const handle = createHandler(buildPartner({ sources: async () => [], model: null }), {
      keys: new Map([[key, "acme"]]),
      dev: false,
    });
    const n = 60_000;
    const body = `{"userId":"u1","sessionId":"s1","kind":"tool_call","tool":"t","input":${"[".repeat(n)}${"]".repeat(n)}}`;
    const res = await handle(
      new Request("http://x/v1/events", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
      }),
    );
    expect(res.status).toBe(400);
  });

  test("EDEN_API_KEYS: a key may hold ':', and one key for two tenants is refused", () => {
    const full = "0123456789abcdef:ZZZZ-rest-of-key";
    const config = loadConfig({ EDEN_API_KEYS: `acme:${full}` });
    expect(config.keys.has("0123456789abcdef")).toBe(false);
    expect(config.keys.get(full)).toBe("acme");
    expect(() => loadConfig({ EDEN_API_KEYS: "acme:0123456789abcdef,globex:0123456789abcdef" })).toThrow(/two tenants/);
  });
});

describe("EDEN_ASK_MODEL (D43)", () => {
  test("off by default; 1 has the model compose ask answers, through loadConfig and buildPartner", async () => {
    expect(loadConfig({ EDEN_DEV: "1" }).askWithModel).toBe(false);
    expect(loadConfig({ EDEN_DEV: "1", EDEN_ASK_MODEL: "0" }).askWithModel).toBe(false);
    expect(() => loadConfig({ EDEN_DEV: "1", EDEN_ASK_MODEL: "yes" })).toThrow(/EDEN_ASK_MODEL/);
    const docs = [{ ref: "d1", title: "Globex renewal", text: "Globex renewal with Dana Lee due Friday" }];
    for (const on of [false, true]) {
      const config = loadConfig({ EDEN_DEV: "1", EDEN_ASK_MODEL: on ? "1" : "0" });
      const model = new FakeModel(() => "Friday [0]");
      const partner = buildPartner({
        sources: async () => [new StaticSource("crm", "Deals", docs)],
        model,
        askWithModel: config.askWithModel,
      });
      const res = await partner.ask({
        tenantId: "dev",
        userId: "u",
        sessionId: "s",
        question: "Globex renewal Dana Lee?",
      });
      expect(res.usedModel).toBe(on);
      expect(model.calls.length).toBe(on ? 1 : 0);
    }
  });
});
