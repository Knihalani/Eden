import { describe, expect, test } from "bun:test";
import { StaticSource } from "@eden/sources";
import { buildPartner } from "./build";
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
