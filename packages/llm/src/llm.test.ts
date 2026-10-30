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
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      json: true,
      cacheKey: "u-3f9a",
    });
    expect(sent.provider).toMatchObject({ data_collection: "deny", zdr: true });
    expect(sent.session_id).toBe("u-3f9a");
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(out).toMatchObject({ text: "{}", costUsd: 0.0001 });
    expect(out.usage.inputTokens).toBe(1000);
    expect(out.truncated).toBe(false);
    expect(sent.reasoning).toBeUndefined();
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
