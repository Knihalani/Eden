import { describe, expect, test } from "bun:test";
import { Budget, TenantSpend } from "./budget";
import { CACHE_TRIP_CALLS, minCacheTokens, OpenRouterModel } from "./openrouter";
import { ModelHeldError, RateHold } from "./pacing";
import { costOf, priceFor } from "./pricing";

describe("pricing", () => {
  test("cached input is billed at the cached rate", () => {
    const price = { input: 1, output: 2, cachedInput: 0.1 };
    expect(costOf({ inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0 }, price)).toBeCloseTo(0.55);
  });

  test("an env override wins and an unknown model is priced high", () => {
    expect(priceFor("x", { EDEN_MODEL_PRICE: "0.05,0.2" })).toEqual({ input: 0.05, output: 0.2 });
    expect(priceFor("unknown/model", {}).input).toBeGreaterThanOrEqual(1);
  });
});

describe("Budget", () => {
  test("refuses once a session's call or spend cap is reached, and settles to actual cost", () => {
    const b = new Budget({ callsPerSession: 2, usdPerSession: 1, usdPerUserDay: 10 });
    const r = b.reserve("u", "s", 0.4);
    expect(r).not.toBeNull();
    b.settle(r!, 0.1);
    expect(b.spent("s").usd).toBeCloseTo(0.1);
    expect(b.charge("u", "s", 0.4)).toBe(true);
    expect(b.charge("u", "s", 0.01)).toBe(false);
  });

  test("the per-user daily cap spans sessions", () => {
    const b = new Budget({ callsPerSession: 99, usdPerSession: 1, usdPerUserDay: 0.5 });
    expect(b.charge("u", "s1", 0.3)).toBe(true);
    expect(b.charge("u", "s2", 0.3)).toBe(false);
    expect(b.charge("other", "s3", 0.3)).toBe(true);
  });
});

describe("Budget reservations", () => {
  test("a call settled after midnight books against the day it was charged, not the new day", () => {
    let now = Date.parse("2026-10-29T23:59:59Z");
    const b = new Budget({ callsPerSession: 99, usdPerSession: 99, usdPerUserDay: 0.5 }, () => now);
    const r = b.reserve("u", "s1", 0.5)!;
    now = Date.parse("2026-10-30T00:00:01Z");
    b.settle(r, 0); // cheaper than estimated: must not credit the new day with money it never reserved
    expect(b.reserve("u", "s2", 0.5)).not.toBeNull();
    expect(b.reserve("u", "s3", 0.01)).toBeNull();
  });

  test("settling a call of an ended session leaves a new session with the same id alone", () => {
    const b = new Budget({ callsPerSession: 1, usdPerSession: 1, usdPerUserDay: 1 });
    const old = b.reserve("u", "s", 0.01)!;
    b.endSession("s");
    expect(b.reserve("u", "s", 0.01)).not.toBeNull();
    b.settle(old, 0);
    expect(b.spent("s").calls).toBe(1);
    expect(b.reserve("u", "s", 0.01)).toBeNull();
  });
});

describe("TenantSpend", () => {
  test("one tenant's daily cap spans users, sessions and every Budget sharing it", () => {
    const tenants = new TenantSpend(0.5);
    const loose = { callsPerSession: 99, usdPerSession: 99, usdPerUserDay: 99 };
    const reader = new Budget(loose, undefined, tenants);
    const cards = new Budget(loose, undefined, tenants);
    expect(reader.charge("acme/u1", "s1", 0.3)).toBe(true);
    // Another user and another role of the same tenant: the tenant's day is spent.
    expect(cards.charge("acme/u2", "bg", 0.3)).toBe(false);
    // Another tenant is not touched by acme's spend.
    expect(cards.charge("beta/u1", "bg", 0.3)).toBe(true);
  });

  test("a refusal by the tenant cap reserves nothing anywhere, and settling books the actual cost", () => {
    const tenants = new TenantSpend(0.5);
    const b = new Budget({ callsPerSession: 99, usdPerSession: 99, usdPerUserDay: 99 }, undefined, tenants);
    const r = b.reserve("acme/u1", "s1", 0.4)!;
    expect(b.reserve("acme/u1", "s1", 0.2)).toBeNull();
    expect(b.spent("s1").calls).toBe(1);
    b.settle(r, 0.1);
    expect(tenants.spent("acme")).toBeCloseTo(0.1);
    expect(b.reserve("acme/u1", "s1", 0.2)).not.toBeNull();
  });

  test("the tally resets with the day and holds only today's tenants", () => {
    let now = Date.parse("2026-11-03T23:00:00Z");
    const tenants = new TenantSpend(0.5, () => now);
    const b = new Budget({ callsPerSession: 99, usdPerSession: 99, usdPerUserDay: 99 }, () => now, tenants);
    expect(b.charge("acme/u1", "s1", 0.5)).toBe(true);
    expect(b.charge("acme/u1", "s2", 0.1)).toBe(false);
    now = Date.parse("2026-11-04T01:00:00Z");
    expect(b.charge("acme/u1", "s3", 0.1)).toBe(true);
    expect(tenants.size).toBe(1);
  });

  test("a user key without a tenant prefix is its own tenant", () => {
    const tenants = new TenantSpend(0.5);
    const b = new Budget({ callsPerSession: 99, usdPerSession: 99, usdPerUserDay: 99 }, undefined, tenants);
    expect(b.charge("u", "s", 0.5)).toBe(true);
    expect(tenants.spent("u")).toBeCloseTo(0.5);
  });
});

describe("OpenRouterModel", () => {
  test("sends the no-retention provider preferences and reads usage and cost", async () => {
    let sent: any;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({
        model: "z-ai/glm-5.3-flash",
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 10, cost: 0.0001 },
      });
    }) as unknown as typeof fetch;
    const model = new OpenRouterModel({ apiKey: "k", model: "z-ai/glm-5.3-flash", fetch: fake });
    const out = await model.chat({
      messages: [{ role: "user", content: "hi", cache: true }],
      maxTokens: 50,
      json: true,
      cacheKey: "u-3f9a",
    });
    // The prompt-cache marker is Anthropic's (`ChatMessage.cache`): never sent for a non-Anthropic model.
    expect(sent.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(sent.provider).toMatchObject({ data_collection: "deny", zdr: true });
    expect(sent.session_id).toBe("u-3f9a");
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(out).toMatchObject({ text: "{}", costUsd: 0.0001 });
    expect(out.usage.inputTokens).toBe(1000);
    expect(out.truncated).toBe(false);
    // A non-Anthropic model asked for no effort is held to "low", excluded: it may reason by default (D45).
    expect(sent.reasoning).toEqual({ effort: "low", exclude: true });
  });

  test("an Anthropic model asked for no effort gets no reasoning field, so it does not think (D144, D155)", async () => {
    let sent: any;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: {} });
    }) as unknown as typeof fetch;
    const model = new OpenRouterModel({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: fake });
    await model.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
    expect("reasoning" in sent).toBe(false);
    await model.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 50, reasoning: "medium" });
    expect(sent.reasoning).toEqual({ effort: "medium", exclude: true });
  });

  test("sends stop sequences only when asked", async () => {
    let sent: any;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: {} });
    }) as unknown as typeof fetch;
    const model = new OpenRouterModel({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: fake });
    await model.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
    expect("stop" in sent).toBe(false);
    await model.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 50, stop: ["X"] });
    expect(sent.stop).toEqual(["X"]);
  });

  test("reads whether the stop ended the reply from the provider's own reason, unset when not given", async () => {
    let native: string | undefined;
    const fake = (async () =>
      Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop", native_finish_reason: native }],
        usage: {},
      })) as unknown as typeof fetch;
    const model = new OpenRouterModel({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: fake });
    const req = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 50, stop: ["X"] };
    native = "stop_sequence";
    expect((await model.chat(req)).stopped).toBe(true);
    native = "end_turn";
    expect((await model.chat(req)).stopped).toBe(false);
    native = undefined;
    expect("stopped" in (await model.chat(req))).toBe(false);
    // Audit A5: OpenAI's "stop" and Google's "STOP" say either a stop hit or a natural end: unset, not false.
    for (const either of ["stop", "STOP"]) {
      native = either;
      expect("stopped" in (await model.chat(req))).toBe(false);
    }
    native = "length";
    expect((await model.chat(req)).stopped).toBe(false);
  });

  test("data collection is denied unless the caller (the lab, on free models) explicitly allows it", async () => {
    const sent: any[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: {} });
    }) as unknown as typeof fetch;
    const req = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 5 };
    await new OpenRouterModel({ apiKey: "k", model: "m", fetch: fake }).chat(req);
    await new OpenRouterModel({ apiKey: "k", model: "m:free", fetch: fake, allowLogging: true }).chat(req);
    expect(sent[0].provider).toMatchObject({ data_collection: "deny", zdr: true });
    expect(sent[1].provider).toMatchObject({ data_collection: "allow", zdr: false });
  });

  test("a 429 holds every role sharing the RateHold; held calls send nothing (D2046, S1-P9)", async () => {
    let now = 1_000_000;
    let calls = 0;
    let status = 200;
    const fake = (async () => {
      calls++;
      if (status === 200) return Response.json({ choices: [{ message: { content: "ok" } }], usage: {} });
      return new Response("slow down", { status: 429, headers: { "retry-after": "5" } });
    }) as unknown as typeof fetch;
    const hold = new RateHold({ now: () => now });
    const a = new OpenRouterModel({ apiKey: "k", model: "m", fetch: fake, rateHold: hold });
    const b = new OpenRouterModel({ apiKey: "k", model: "m", fetch: fake, rateHold: hold });
    const req = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 5 };

    status = 429;
    await expect(a.chat(req)).rejects.toThrow("openrouter 429");
    // Another role sharing the hold sends nothing while the server-named delay runs.
    const held = await b.chat(req).then(
      () => null,
      (e) => e,
    );
    expect(held).toBeInstanceOf(ModelHeldError);
    expect(calls).toBe(1);
    expect(hold.skipped).toBe(1);
    // Still held inside the delay; past it, calls go through and the streak clears.
    now += 4_000;
    const still = await a.chat(req).then(
      () => null,
      (e) => e,
    );
    expect(still).toBeInstanceOf(ModelHeldError);
    expect(calls).toBe(1);
    now += 2_000;
    status = 200;
    await b.chat(req);
    expect(calls).toBe(2);
    expect(hold.held()).toBe(false);
  });

  test("a hold that lands mid-call stops the cache-fallback resend (D2046, S1-P9)", async () => {
    let calls = 0;
    const hold = new RateHold({ now: () => 1_000_000 });
    const fake = (async () => {
      calls++;
      if (calls === 1) {
        // Another role's 429 lands while this call is in-flight (the hold is shared per account).
        hold.note(new Response("slow down", { status: 429, headers: { "retry-after": "60" } }));
        return new Response("cache fields refused", { status: 400 });
      }
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: {} });
    }) as unknown as typeof fetch;
    const b = new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/x",
      anthropicCache: true,
      fetch: fake,
      rateHold: hold,
    });
    const req = {
      messages: [
        { role: "system" as const, content: "fixed instructions" },
        { role: "user" as const, content: "hi" },
      ],
      maxTokens: 5,
    };
    // The first send got a 400 cache refusal, but resending during the hold would send into the limit.
    await expect(b.chat(req)).rejects.toBeInstanceOf(ModelHeldError);
    expect(calls).toBe(1);
    expect(hold.skipped).toBe(1);
  });

  test("a free model (OpenRouter's :free suffix) is priced at zero; an unknown one stays priced high", () => {
    expect(priceFor("nvidia/nemotron-3.5-super-vl:free", {})).toEqual({ input: 0, output: 0 });
    expect(priceFor("someone/unknown-model", {})).toEqual({ input: 1, output: 4 });
  });

  test("fromEnv denies data collection whatever the environment says; only the lab's explicit option allows it", async () => {
    const sent: any[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: "{}" } }], usage: {} });
    }) as unknown as typeof fetch;
    const env = { OPENROUTER_API_KEY: "k", EDEN_MODEL_ZDR: "off", EDEN_LAB_DATA_COLLECTION: "allow" };
    const prod = OpenRouterModel.fromEnv(env)!;
    (prod as unknown as { options: { fetch: typeof fetch } }).options.fetch = fake;
    await prod.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 5 });
    expect(sent[0].provider.data_collection).toBe("deny");
    const lab = new OpenRouterModel({ apiKey: "k", model: "m:free", allowLogging: true, fetch: fake });
    await lab.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 5 });
    expect(sent[1].provider).toMatchObject({ data_collection: "allow", zdr: false });
  });

  const capture = () => {
    const sent: any[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: "{}" } }], usage: {} });
    }) as unknown as typeof fetch;
    return { sent, fake };
  };
  const cachedRequest = {
    messages: [
      { role: "system" as const, content: "rules" },
      { role: "system" as const, content: "more rules" },
      { role: "user" as const, content: "standing prefix", cache: true },
      { role: "user" as const, content: "the request" },
    ],
    maxTokens: 50,
    json: true,
    cacheKey: "u-3f9a",
  };

  test("the default glm request body is unchanged: plain string content, no cache_control (snapshot)", async () => {
    const { sent, fake } = capture();
    await new OpenRouterModel({ apiKey: "k", model: "z-ai/glm-5.3-flash", fetch: fake }).chat(cachedRequest);
    // The body as before cache_control support, byte for byte, plus D155's reasoning hold for non-Anthropic models.
    expect(JSON.stringify(sent[0])).toBe(
      JSON.stringify({
        model: "z-ai/glm-5.3-flash",
        messages: [
          { role: "system", content: "rules" },
          { role: "system", content: "more rules" },
          { role: "user", content: "standing prefix" },
          { role: "user", content: "the request" },
        ],
        max_tokens: 50,
        temperature: 0,
        response_format: { type: "json_object" },
        // A non-Anthropic model is held to low, excluded reasoning when asked for none (it may reason by default).
        reasoning: { effort: "low", exclude: true },
        provider: { data_collection: "deny", zdr: true, allow_fallbacks: true },
        usage: { include: true },
        session_id: "u-3f9a",
      }),
    );
  });

  test("the cached prefix is byte-identical across calls whose requests differ (D1196, D1790)", async () => {
    const { sent, fake } = capture();
    const model = new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    });
    const ask = (request: string) =>
      model.chat({
        messages: [
          { role: "system", content: "fixed instructions" },
          { role: "user", content: request },
        ],
        maxTokens: 5,
        cacheKey: "u-1",
      });
    await ask("book the lake house on 12 May");
    await ask("pay the Harlow deposit");
    const prefix = (body: any) => JSON.stringify([body.model, body.messages[0]]);
    expect(prefix(sent[0])).toBe(prefix(sent[1]));
    expect(sent[0].messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(sent[0].messages[1]).toEqual({ role: "user", content: "book the lake house on 12 May" });
    // Another provider's model never gets the field: the option is a no-op there.
    const other = new OpenRouterModel({ apiKey: "k", model: "z-ai/glm-5.3-flash", fetch: fake, anthropicCache: true });
    await other.chat({ messages: [{ role: "system", content: "fixed instructions" }], maxTokens: 5 });
    expect(sent[2].messages[0]).toEqual({ role: "system", content: "fixed instructions" });
  });

  test("an anthropic/* request is unchanged by default: no cache_control unless anthropicCache is set", async () => {
    const { sent, fake } = capture();
    await new OpenRouterModel({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: fake }).chat(cachedRequest);
    expect(sent[0].messages).toEqual([
      { role: "system", content: "rules" },
      { role: "system", content: "more rules" },
      { role: "user", content: "standing prefix" },
      { role: "user", content: "the request" },
    ]);
    expect(sent[0].session_id).toBe("u-3f9a");
  });

  test("an anthropic/* model gets cache_control on the last system message and on marked messages", async () => {
    const { sent, fake } = capture();
    await new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    }).chat(cachedRequest);
    const ephemeral = { type: "ephemeral" };
    expect(sent[0].messages).toEqual([
      { role: "system", content: "rules" },
      { role: "system", content: [{ type: "text", text: "more rules", cache_control: ephemeral }] },
      { role: "user", content: [{ type: "text", text: "standing prefix", cache_control: ephemeral }] },
      { role: "user", content: "the request" },
    ]);
    expect(sent[0].session_id).toBe("u-3f9a");
    // D12 routing is untouched by the cache markers.
    expect(sent[0].model).toBe("anthropic/claude-haiku-5.5");
    expect(sent[0].provider).toEqual({ data_collection: "deny", zdr: true, allow_fallbacks: true });
  });

  test("an anthropic/* request with a message asking a 1-hour TTL sends every breakpoint at 1 hour (D1197)", async () => {
    const { sent, fake } = capture();
    const model = new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    });
    const hourly = {
      ...cachedRequest,
      messages: cachedRequest.messages.map((m) => (m.cache ? { ...m, cacheTtl: "1h" as const } : m)),
    };
    await model.chat(hourly);
    const hour = { type: "ephemeral", ttl: "1h" };
    expect(sent[0].messages).toEqual([
      { role: "system", content: "rules" },
      { role: "system", content: [{ type: "text", text: "more rules", cache_control: hour }] },
      { role: "user", content: [{ type: "text", text: "standing prefix", cache_control: hour }] },
      { role: "user", content: "the request" },
    ]);
    // The cached prefix's bytes do not depend on the TTL ask or on the request after it.
    await model.chat({ ...hourly, messages: [...hourly.messages.slice(0, 3), { role: "user", content: "another" }] });
    expect(JSON.stringify(sent[1].messages.slice(0, 3))).toBe(JSON.stringify(sent[0].messages.slice(0, 3)));
    // Without anthropicCache, nothing of it reaches the wire.
    await new OpenRouterModel({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: fake }).chat(hourly);
    expect(JSON.stringify(sent[2].messages)).not.toContain("cache_control");
  });

  test("an anthropic/* request has at most 4 breakpoints: the last system message, then the latest marked", async () => {
    const { sent, fake } = capture();
    const marked = (i: number) => ({ role: "user" as const, content: `prefix ${i}`, cache: true });
    await new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    }).chat({
      messages: [{ role: "system", content: "rules" }, ...[0, 1, 2, 3, 4].map(marked), { role: "user", content: "q" }],
      maxTokens: 5,
    });
    const msgs = sent[0].messages as { role: string; content: unknown }[];
    const breakpoints = msgs.flatMap((m, i) => (Array.isArray(m.content) ? [i] : []));
    // Anthropic rejects a request with more than 4: system (0), and the three latest marked (prefix 2, 3, 4).
    expect(breakpoints).toEqual([0, 3, 4, 5]);
    expect(msgs[1]).toEqual({ role: "user", content: "prefix 0" });
    expect(msgs[2]).toEqual({ role: "user", content: "prefix 1" });
  });

  test("an anthropic/* request never puts cache_control on empty text", async () => {
    const { sent, fake } = capture();
    await new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    }).chat({
      messages: [
        { role: "system", content: "rules" },
        { role: "system", content: "" },
        { role: "user", content: "  ", cache: true },
        { role: "user", content: "q" },
      ],
      maxTokens: 5,
    });
    // The empty system message is not the breakpoint: the last non-empty one is. Empty text stays a plain string.
    expect(sent[0].messages).toEqual([
      { role: "system", content: [{ type: "text", text: "rules", cache_control: { type: "ephemeral" } }] },
      { role: "system", content: "" },
      { role: "user", content: "  " },
      { role: "user", content: "q" },
    ]);
  });

  test("an anthropic/* request with no system message and no marker sends plain string content", async () => {
    const { sent, fake } = capture();
    await new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    }).chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 5,
    });
    expect(sent[0].messages).toEqual([{ role: "user", content: "hi" }]);
    expect(sent[0].session_id).toBeUndefined();
  });

  // A route that refuses `cache_control` (or its hour TTL) answers 400; D1790 turns the caching on by default, so a
  // refusal must cost no call. `refuse` says which bodies the fake route rejects.
  const refusing = (refuse: (body: any) => boolean) => {
    const sent: any[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      if (refuse(body)) return new Response('{"error":"bad cache_control"}', { status: 400 });
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: {} });
    }) as unknown as typeof fetch;
    return { sent, fake };
  };
  const hasControl = (body: any) => JSON.stringify(body.messages).includes("cache_control");
  const hasHour = (body: any) => JSON.stringify(body.messages).includes('"ttl":"1h"');
  const hourRequest = {
    messages: [
      { role: "system" as const, content: "rules" },
      { role: "user" as const, content: "sheet", cache: true, cacheTtl: "1h" as const },
      { role: "user" as const, content: "the request" },
    ],
    maxTokens: 5,
  };

  test("D1790: a route refusing cache_control gets every call, and after two refusals the model stops sending it", async () => {
    const { sent, fake } = refusing(hasControl);
    const model = new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    });
    expect((await model.chat(cachedRequest)).text).toBe("ok");
    expect(sent.map(hasControl)).toEqual([true, false]);
    // One refusal is not enough: a stray 400 must not turn the caching off for the process.
    expect(model.cacheLevel).toBe(2);
    expect((await model.chat(cachedRequest)).text).toBe("ok");
    expect(sent.map(hasControl)).toEqual([true, false, true, false]);
    expect(model.cacheLevel).toBe(0);
    await model.chat(cachedRequest);
    expect(sent.length).toBe(5);
    expect(hasControl(sent[4])).toBe(false);
  });

  test("D1790: a call answered at its own level resets the count of refusals", async () => {
    let refuse = true;
    const { sent, fake } = refusing((body) => refuse && hasControl(body));
    const model = new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    });
    await model.chat(cachedRequest);
    refuse = false;
    await model.chat(cachedRequest);
    refuse = true;
    await model.chat(cachedRequest);
    expect(sent.length).toBe(5);
    expect(model.cacheLevel).toBe(2);
  });

  test("D1790: a route refusing only the hour's TTL keeps the system prefix's breakpoint and drops the hour's", async () => {
    const { sent, fake } = refusing(hasHour);
    const model = new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    });
    expect((await model.chat(hourRequest)).text).toBe("ok");
    expect(sent.map(hasHour)).toEqual([true, false]);
    // Level 1: the system message keeps its five-minute breakpoint; the sheet (which asked for an hour) has none, since
    // at five minutes it would cost more than sending it plain (D1197).
    expect(sent[1].messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(sent[1].messages[1]).toEqual({ role: "user", content: "sheet" });
    await model.chat(hourRequest);
    expect(model.cacheLevel).toBe(1);
  });

  test("D1790: a 400 for another reason throws and leaves the caching as it was", async () => {
    const { sent, fake } = refusing(() => true);
    const model = new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    });
    await expect(model.chat(hourRequest)).rejects.toThrow(/openrouter 400/);
    // Tried at each level once: hour TTL, five minutes, none.
    expect(sent.length).toBe(3);
    expect(model.cacheLevel).toBe(2);
    // A request with no breakpoint is never retried.
    const plain = new OpenRouterModel({ apiKey: "k", model: "z-ai/glm-5.3-flash", fetch: fake, anthropicCache: true });
    await expect(plain.chat(cachedRequest)).rejects.toThrow(/openrouter 400/);
    expect(sent.length).toBe(4);
  });

  test("D1790: an error other than 400 is never retried", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response("busy", { status: 503 });
    }) as unknown as typeof fetch;
    const model = new OpenRouterModel({
      apiKey: "k",
      model: "anthropic/claude-haiku-5.5",
      fetch: fake,
      anthropicCache: true,
    });
    await expect(model.chat(cachedRequest)).rejects.toThrow(/openrouter 503/);
    expect(calls).toBe(1);
    expect(model.cacheLevel).toBe(2);
  });

  test("asks for low reasoning effort when told, and reports a reply cut off at the cap (D45)", async () => {
    let sent: any;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({
        choices: [{ message: { content: '{"pick' }, finish_reason: "length" }],
        usage: { prompt_tokens: 300, completion_tokens: 60 },
      });
    }) as unknown as typeof fetch;
    const model = new OpenRouterModel({ apiKey: "k", model: "z-ai/glm-5.3-flash", fetch: fake });
    const out = await model.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 60, reasoning: "low" });
    expect(sent.reasoning).toEqual({ effort: "low", exclude: true });
    expect(out.truncated).toBe(true);
  });

  test("explicit off disables reasoning without changing the output cap or JSON request", async () => {
    for (const id of ["deepseek/deepseek-v4.1-flash", "anthropic/claude-haiku-5.5"]) {
      let sent: any;
      const fake = (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return Response.json({ choices: [{ message: { content: '{"items":[]}' }, finish_reason: "stop" }] });
      }) as unknown as typeof fetch;
      const model = new OpenRouterModel({ apiKey: "k", model: id, fetch: fake });
      const result = await model.chat({
        messages: [{ role: "user", content: "check" }],
        maxTokens: 500,
        json: true,
        reasoning: "off",
      });
      expect(sent.reasoning).toEqual({ enabled: false, exclude: true });
      expect(sent.max_tokens).toBe(500);
      expect(sent.response_format).toEqual({ type: "json_object" });
      expect(result.text).toBe('{"items":[]}');
      expect(result.truncated).toBe(false);
    }
  });

  test("a provider refusal of reasoning off fails rather than retrying with reasoning enabled", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response("unsupported reasoning setting", { status: 400 });
    }) as unknown as typeof fetch;
    const model = new OpenRouterModel({ apiKey: "k", model: "deepseek/deepseek-v4.1-flash", fetch: fake });
    await expect(model.chat({ messages: [], maxTokens: 500, reasoning: "off" })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("reads the hidden reasoning's share of the output when reported, and leaves it unset when not", async () => {
    const replies = [
      { prompt_tokens: 300, completion_tokens: 310, completion_tokens_details: { reasoning_tokens: 120 } },
      { prompt_tokens: 300, completion_tokens: 190 },
      { prompt_tokens: 300, completion_tokens: 190, completion_tokens_details: {} },
    ];
    let i = 0;
    const fake = (async () =>
      Response.json({ choices: [{ message: { content: "{}" } }], usage: replies[i++] })) as unknown as typeof fetch;
    const model = new OpenRouterModel({ apiKey: "k", model: "z-ai/glm-5.3-flash", fetch: fake });
    const req = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 500, reasoning: "low" as const };
    const reported = await model.chat(req);
    expect(reported.usage.reasoningTokens).toBe(120);
    expect(reported.usage.outputTokens).toBe(310);
    for (const _ of [1, 2]) {
      const silent = await model.chat(req);
      expect(silent.usage.reasoningTokens).toBeUndefined();
      expect("reasoningTokens" in silent.usage).toBe(false);
      expect(silent.usage.outputTokens).toBe(190);
    }
  });
});

// D1800: a route that bills cache writes and never serves a read is stopped after CACHE_TRIP_CALLS calls that should
// have read; a cold start, low traffic or a short prefix never counts.
describe("OpenRouterModel's read watch (D1800)", () => {
  const LONG = "x".repeat(minCacheTokens("anthropic/claude-haiku-5.5") * 4 + 400);
  const request = (system = LONG, sheet?: string) => ({
    messages: [
      { role: "system" as const, content: system },
      ...(sheet ? [{ role: "user" as const, content: sheet, cache: true, cacheTtl: "1h" as const }] : []),
      { role: "user" as const, content: "the request" },
    ],
    maxTokens: 5,
  });
  const route = (cached: () => number, write?: number) => {
    const sent: any[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      const details = { cached_tokens: cached(), ...(write === undefined ? {} : { cache_write_tokens: write }) };
      return Response.json({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 900, prompt_tokens_details: details },
      });
    }) as unknown as typeof fetch;
    return { sent, fake };
  };
  const model = (fake: typeof fetch, now: () => number) =>
    new OpenRouterModel({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: fake, anthropicCache: true, now });
  const hasControl = (body: any) => JSON.stringify(body.messages).includes("cache_control");

  test("trips after CACHE_TRIP_CALLS calls that should have read and read nothing, and logs one line", async () => {
    const { sent, fake } = route(() => 0);
    let now = 0;
    const m = model(fake, () => now);
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (line: string) => lines.push(line);
    try {
      // The first call writes; each later one, a minute after, should read it.
      for (let i = 0; i <= CACHE_TRIP_CALLS; i++, now += 60_000) await m.chat(request());
      expect(m.cacheLevel).toBe(0);
      expect(m.readsMissed).toBe(CACHE_TRIP_CALLS);
      expect(sent.every(hasControl)).toBe(true);
      const res = await m.chat(request());
      expect(hasControl(sent.at(-1))).toBe(false);
      expect(res.cacheBreakpoints).toBeUndefined();
    } finally {
      console.warn = warn;
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("cache level 2 -> 0");
    // Content-free: no prompt text in the line.
    expect(lines[0]).not.toContain("xxxx");
  });

  test("one call short of it does not trip", async () => {
    const { fake } = route(() => 0);
    let now = 0;
    const m = model(fake, () => now);
    for (let i = 0; i < CACHE_TRIP_CALLS; i++, now += 60_000) await m.chat(request());
    expect(m.readsMissed).toBe(CACHE_TRIP_CALLS - 1);
    expect(m.cacheLevel).toBe(2);
  });

  test("low traffic: calls further apart than the TTL never count", async () => {
    const { fake } = route(() => 0);
    let now = 0;
    const m = model(fake, () => now);
    for (let i = 0; i < 3 * CACHE_TRIP_CALLS; i++, now += 6 * 60_000) await m.chat(request());
    expect(m.readsMissed).toBe(0);
    expect(m.cacheLevel).toBe(2);
  });

  test("an hour's breakpoint is watched on the hour: checks 30 minutes apart count", async () => {
    const { fake } = route(() => 0);
    let now = 0;
    const m = model(fake, () => now);
    for (let i = 0; i < 3; i++, now += 30 * 60_000) await m.chat(request(LONG, "the user's sheet"));
    expect(m.readsMissed).toBe(2);
  });

  test("a prefix too short to cache never counts", async () => {
    const { fake } = route(() => 0);
    let now = 0;
    const m = model(fake, () => now);
    for (let i = 0; i < 2 * CACHE_TRIP_CALLS; i++, now += 60_000) await m.chat(request("short rules"));
    expect(m.readsMissed).toBe(0);
    expect(m.cacheLevel).toBe(2);
  });

  test("a cold start does not count: every call a new prefix", async () => {
    const { fake } = route(() => 0);
    let now = 0;
    const m = model(fake, () => now);
    for (let i = 0; i < 2 * CACHE_TRIP_CALLS; i++, now += 60_000) await m.chat(request(`${LONG}${i}`));
    expect(m.readsMissed).toBe(0);
  });

  test("calls in flight together do not count: the second was sent before the first was answered", async () => {
    const { fake } = route(() => 0);
    // A clock that moves on each reading: every call is sent before the first is answered.
    let tick = 0;
    const m = model(fake, () => tick++);
    await Promise.all(Array.from({ length: 2 * CACHE_TRIP_CALLS }, () => m.chat(request())));
    expect(m.readsMissed).toBe(0);
    expect(m.cacheLevel).toBe(2);
  });

  test("one read ends the watch for good", async () => {
    let n = 0;
    const { fake } = route(() => (n++ === 3 ? 600 : 0));
    let now = 0;
    const m = model(fake, () => now);
    for (let i = 0; i < 3 * CACHE_TRIP_CALLS; i++, now += 60_000) await m.chat(request());
    expect(m.readsSeen).toBe(true);
    expect(m.readsMissed).toBe(2);
    expect(m.cacheLevel).toBe(2);
  });

  test("the response says how many breakpoints it carried, and the cache writes when the route reports them", async () => {
    const { fake } = route(() => 0, 700);
    const res = await model(fake, () => 0).chat(request(LONG, "the user's sheet"));
    expect(res.cacheBreakpoints).toBe(2);
    expect(res.usage.cacheWriteTokens).toBe(700);
    const plain = route(() => 0);
    const off = await new OpenRouterModel({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: plain.fake }).chat(
      request(),
    );
    expect(off.cacheBreakpoints).toBeUndefined();
    // Not reported: unset, not zero.
    expect(off.usage.cacheWriteTokens).toBeUndefined();
  });

  test("the bytes the model reads are the same with and without the sheet's breakpoint (D1800)", async () => {
    const { sent, fake } = route(() => 0);
    const m = model(fake, () => 0);
    const marked = request(LONG, "the user's sheet");
    const plain = { ...marked, messages: marked.messages.map(({ cache: _c, cacheTtl: _t, ...rest }: any) => rest) };
    await m.chat(marked);
    await m.chat(plain);
    const texts = (body: any) =>
      body.messages.map((x: any) => [x.role, typeof x.content === "string" ? x.content : x.content[0].text]);
    expect(texts(sent[0])).toEqual(texts(sent[1]));
    expect(JSON.stringify(sent[0].messages[1])).toContain("cache_control");
    expect(JSON.stringify(sent[1].messages[1])).not.toContain("cache_control");
  });
});

// D1800 (review): each breakpoint gets its own TTL, longer before shorter; hour refusals are counted apart; the read
// watch's minimum prefix is the model's own.
describe("OpenRouterModel's TTLs and refusals (D1800)", () => {
  const ok = () => {
    const sent: any[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      if (JSON.stringify(body.messages).includes('"ttl":"1h"') && refuseHour) {
        return new Response('{"error":"bad ttl"}', { status: 400 });
      }
      return Response.json({ choices: [{ message: { content: "ok" } }], usage: {} });
    }) as unknown as typeof fetch;
    return { sent, fake };
  };
  let refuseHour = false;
  const model = (fake: typeof fetch, name = "anthropic/claude-haiku-5.5", now?: () => number) =>
    new OpenRouterModel({ apiKey: "k", model: name, fetch: fake, anthropicCache: true, ...(now ? { now } : {}) });
  const control = (body: any) =>
    body.messages.map((m: any) => (Array.isArray(m.content) ? m.content[0].cache_control : null));
  const hour = { type: "ephemeral", ttl: "1h" };
  const five = { type: "ephemeral" };
  const sys = (ttl?: "1h") => ({
    role: "system" as const,
    content: "rules",
    ...(ttl ? { cache: true, cacheTtl: ttl } : {}),
  });
  const sheet = (ttl?: "1h") => ({
    role: "user" as const,
    content: "sheet",
    ...(ttl ? { cache: true, cacheTtl: ttl } : {}),
  });
  const ask = { role: "user" as const, content: "the request" };

  test("the instructions can ask the hour alone; a later hour carries every earlier breakpoint with it", async () => {
    refuseHour = false;
    const { sent, fake } = ok();
    const m = model(fake);
    await m.chat({ messages: [sys("1h"), sheet(), ask], maxTokens: 5 });
    expect(control(sent[0])).toEqual([hour, null, null]);
    await m.chat({ messages: [sys(), sheet("1h"), ask], maxTokens: 5 });
    expect(control(sent[1])).toEqual([hour, hour, null]);
    // An hour first and five minutes after it is Anthropic's order; never five minutes before an hour.
    const late = { role: "user" as const, content: "late", cache: true };
    await m.chat({ messages: [sys("1h"), late, ask], maxTokens: 5 });
    expect(control(sent[2])).toEqual([hour, five, null]);
    await m.chat({ messages: [sys(), sheet(), ask], maxTokens: 5 });
    expect(control(sent[3])).toEqual([five, null, null]);
  });

  test("a refused hour keeps the instructions' breakpoint at five minutes (level 1)", async () => {
    refuseHour = true;
    const { sent, fake } = ok();
    const m = model(fake);
    expect((await m.chat({ messages: [sys("1h"), ask], maxTokens: 5 })).text).toBe("ok");
    expect(control(sent[0])).toEqual([hour, null]);
    expect(control(sent[1])).toEqual([five, null]);
    refuseHour = false;
  });

  test("hour refusals are counted apart: interleaved with hour-free requests, two lower the level to 1", async () => {
    refuseHour = true;
    const { sent, fake } = ok();
    const m = model(fake);
    for (let i = 0; i < 40; i++) {
      await m.chat({ messages: i % 2 === 0 ? [sys(), sheet("1h"), ask] : [sys(), ask], maxTokens: 5 });
    }
    expect(m.cacheLevel).toBe(1);
    // Two refused hours (two POSTs each), then one POST a call: the hour is no longer sent.
    expect(sent.length).toBe(42);
    expect(sent.slice(-10).some((b) => JSON.stringify(b.messages).includes('"ttl":"1h"'))).toBe(false);
    refuseHour = false;
  });

  test("the read watch counts only prefixes the model can cache: an unlisted model's minimum is 4,096", async () => {
    expect(minCacheTokens("anthropic/claude-haiku-5.5")).toBe(512);
    expect(minCacheTokens("anthropic/claude-some-other")).toBe(4_096);
    const fake = (async () =>
      Response.json({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens_details: { cached_tokens: 0 } },
      })) as unknown as typeof fetch;
    let now = 0;
    const mid = "x".repeat(1_000 * 4);
    const other = model(fake, "anthropic/claude-some-other", () => now);
    const haiku = model(fake, "anthropic/claude-haiku-5.5", () => now);
    for (let i = 0; i < 2 * CACHE_TRIP_CALLS; i++, now += 60_000) {
      await other.chat({ messages: [{ role: "system", content: mid }, ask], maxTokens: 5 });
      await haiku.chat({ messages: [{ role: "system", content: mid }, ask], maxTokens: 5 });
    }
    expect(other.readsMissed).toBe(0);
    expect(other.cacheLevel).toBe(2);
    // The same 1,000-token prefix is cacheable on Haiku 5.5: there it counts, and trips.
    expect(haiku.cacheLevel).toBe(0);
  });
});
