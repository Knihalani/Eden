import { describe, expect, test } from "bun:test";
import { Budget } from "./budget";
import { OpenRouterModel } from "./openrouter";
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
    expect(sent.reasoning).toBeUndefined();
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
    // The body as it was before cache_control support, byte for byte.
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
        provider: { data_collection: "deny", zdr: true, allow_fallbacks: true },
        usage: { include: true },
        session_id: "u-3f9a",
      }),
    );
  });

  test("an anthropic/* model gets cache_control on the last system message and on marked messages", async () => {
    const { sent, fake } = capture();
    await new OpenRouterModel({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: fake }).chat(cachedRequest);
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

  test("an anthropic/* request with no system message and no marker sends plain string content", async () => {
    const { sent, fake } = capture();
    await new OpenRouterModel({ apiKey: "k", model: "anthropic/claude-haiku-5.5", fetch: fake }).chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 5,
    });
    expect(sent[0].messages).toEqual([{ role: "user", content: "hi" }]);
    expect(sent[0].session_id).toBeUndefined();
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
});
