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
    expect(b.charge("u", "s", 0.4)).toBe(true);
    b.settle("u", "s", 0.4, 0.1);
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
  });
});
