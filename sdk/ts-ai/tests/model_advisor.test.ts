/**
 * Tests for the ModelAdvisor TS SDK wrapper.
 *
 * Mirrors `sdk/python/tests/test_model_advisor.py`. We don't hit
 * the live API - we inject a fake `fetch` and verify that the
 * SDK's request shape + response parsing match the backend's
 * `/orgs/{org_id}/models/{compare,recommend,project}` endpoints.
 */

import { describe, expect, it } from "bun:test";

import {
  ModelAdvisor,
  ModelAdvisorError,
  type ModelComparison,
  type Recommendation,
  type SwitchProjection,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────
// Fake fetch helpers
// ─────────────────────────────────────────────────────────────────────

type FetchCall = { url: string; init: RequestInit };

interface FakeFetchOptions {
  status?: number;
  body?: unknown;
  /** When set, the next fetch call throws this Error (transport failure). */
  transportError?: Error;
}

function makeFakeFetch(opts: FakeFetchOptions = {}): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (opts.transportError) throw opts.transportError;
    const status = opts.status ?? 200;
    const bodyText = opts.body === undefined ? "" : JSON.stringify(opts.body);
    return new Response(bodyText, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const FAKE_COMPARE_RESPONSE = {
  current: {
    provider: "openai",
    model_id: "gpt-4o",
    quality: 0.93,
    latency_p95_ms: 700,
    reliability: 0.999,
    context_window: 128000,
    cost_per_1k_input: 0.0025,
    cost_per_1k_output: 0.01,
    cost_per_1k_cache_read: 0.00125,
    cost_per_1k_cache_write: null,
    source: "static",
  },
  candidate: {
    provider: "openai",
    model_id: "gpt-4o-mini",
    quality: 0.85,
    latency_p95_ms: 350,
    reliability: 0.999,
    context_window: 128000,
    cost_per_1k_input: 0.00015,
    cost_per_1k_output: 0.0006,
    cost_per_1k_cache_read: 0.000075,
    cost_per_1k_cache_write: null,
    source: "static",
  },
  delta_cost_per_1k_input: -0.00235,
  delta_cost_per_1k_output: -0.0094,
  delta_quality: -0.08,
  delta_latency_p95_ms: -350,
  delta_reliability: 0,
  cost_ratio: 0.06,
};

const FAKE_RECOMMEND_RESPONSE = {
  recommended_provider: "anthropic",
  recommended_model_id: "claude-sonnet-4-6",
  score: 0.82,
  rationale: "frontier-tier quality; fast",
  monthly_savings_usd: null,
  current_provider: null,
  current_model_id: null,
  runners_up: [
    {
      provider: "openai",
      model_id: "gpt-4o",
      score: 0.79,
      rationale: "balanced",
    },
  ],
  empty_history: false,
};

const FAKE_PROJECT_RESPONSE = {
  current_provider: "openai",
  current_model_id: "gpt-4o",
  candidate_provider: "openai",
  candidate_model_id: "gpt-4o-mini",
  current_total_usd: 300.0,
  projected_total_usd: 35.0,
  savings_usd: 265.0,
  savings_pct: 88.3,
  per_request_savings_usd: 0.0088,
  cache_savings_usd: 5.0,
  window_days: 30,
  requests_in_window: 30000,
};

// ─────────────────────────────────────────────────────────────────────
// compare
// ─────────────────────────────────────────────────────────────────────

describe("ModelAdvisor.compare", () => {
  it("returns a parsed ModelComparison", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ body: FAKE_COMPARE_RESPONSE });
    const advisor = new ModelAdvisor({
      apiKey: "sk-test",
      orgId: "org_123",
      baseUrl: "https://test.eden.local",
      fetchImpl,
    });

    const cmp: ModelComparison = await advisor.compare(
      "org_123",
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "openai", modelId: "gpt-4o-mini" },
    );

    expect(cmp.current.modelId).toBe("gpt-4o");
    expect(cmp.candidate.modelId).toBe("gpt-4o-mini");
    expect(cmp.candidate.costPer1kCacheRead).toBeCloseTo(0.000075);
    expect(cmp.costRatio).toBeCloseTo(0.06);

    // URL + body shape
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://test.eden.local/orgs/org_123/models/compare");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.current.model_id).toBe("gpt-4o");
    expect(body.candidate.provider).toBe("openai");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("raises ModelAdvisorError on 4xx with the API detail", async () => {
    const { fetchImpl } = makeFakeFetch({
      status: 404,
      body: { detail: "Unknown model: gpt-99" },
    });
    const advisor = new ModelAdvisor({
      baseUrl: "https://test.eden.local",
      fetchImpl,
    });
    await expect(
      advisor.compare(
        "org_123",
        { provider: "openai", modelId: "gpt-4o" },
        { provider: "openai", modelId: "gpt-99" },
      ),
    ).rejects.toThrow(ModelAdvisorError);
    try {
      await advisor.compare(
        "org_123",
        { provider: "openai", modelId: "gpt-4o" },
        { provider: "openai", modelId: "gpt-99" },
      );
    } catch (err) {
      expect((err as ModelAdvisorError).statusCode).toBe(404);
      expect((err as ModelAdvisorError).reason).toContain("gpt-99");
    }
  });

  it("raises ModelAdvisorError on transport failure", async () => {
    const { fetchImpl } = makeFakeFetch({
      transportError: new Error("dns down"),
    });
    const advisor = new ModelAdvisor({
      baseUrl: "https://test.eden.local",
      fetchImpl,
    });
    try {
      await advisor.compare(
        "org_123",
        { provider: "openai", modelId: "gpt-4o" },
        { provider: "openai", modelId: "gpt-4o-mini" },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ModelAdvisorError);
      expect((err as ModelAdvisorError).statusCode).toBe(0);
      expect((err as ModelAdvisorError).reason).toContain("dns");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// recommend
// ─────────────────────────────────────────────────────────────────────

describe("ModelAdvisor.recommend", () => {
  it("pick mode omits `current` from the body", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      body: FAKE_RECOMMEND_RESPONSE,
    });
    const advisor = new ModelAdvisor({
      baseUrl: "https://test.eden.local",
      fetchImpl,
    });

    const rec: Recommendation = await advisor.recommend("org_123", {
      candidates: [
        { provider: "openai", modelId: "gpt-4o" },
        { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      ],
    });

    expect(rec.recommendedProvider).toBe("anthropic");
    expect(rec.recommendedModelId).toBe("claude-sonnet-4-6");
    expect(rec.monthlySavingsUsd).toBeNull();
    expect(rec.currentModelId).toBeNull();

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.mode).toBe("pick");
    expect(body.current).toBeUndefined();
  });

  it("switch mode includes current + windowDays in the body", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      body: {
        ...FAKE_RECOMMEND_RESPONSE,
        monthly_savings_usd: 195.0,
        current_provider: "openai",
        current_model_id: "gpt-4o",
        recommended_model_id: "gpt-4o-mini",
      },
    });
    const advisor = new ModelAdvisor({
      baseUrl: "https://test.eden.local",
      fetchImpl,
    });
    const rec = await advisor.recommend("org_123", {
      candidates: [
        { provider: "openai", modelId: "gpt-4o" },
        { provider: "openai", modelId: "gpt-4o-mini" },
      ],
      current: { provider: "openai", modelId: "gpt-4o" },
      windowDays: 14,
    });
    expect(rec.recommendedModelId).toBe("gpt-4o-mini");
    expect(rec.monthlySavingsUsd).toBeCloseTo(195.0);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.mode).toBe("switch");
    expect(body.current.model_id).toBe("gpt-4o");
    expect(body.window_days).toBe(14);
  });

  it("rejects empty candidate lists", async () => {
    const { fetchImpl } = makeFakeFetch();
    const advisor = new ModelAdvisor({
      baseUrl: "https://test.eden.local",
      fetchImpl,
    });
    await expect(
      advisor.recommend("org_123", { candidates: [] }),
    ).rejects.toThrow(/at least one/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// project
// ─────────────────────────────────────────────────────────────────────

describe("ModelAdvisor.project", () => {
  it("returns a parsed SwitchProjection", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ body: FAKE_PROJECT_RESPONSE });
    const advisor = new ModelAdvisor({
      baseUrl: "https://test.eden.local",
      fetchImpl,
    });

    const proj: SwitchProjection = await advisor.project("org_123", {
      current: { provider: "openai", modelId: "gpt-4o" },
      candidate: { provider: "openai", modelId: "gpt-4o-mini" },
    });

    expect(proj.savingsPct).toBeCloseTo(88.3);
    expect(proj.requestsInWindow).toBe(30000);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.scale_factor).toBe(1.0);
    expect(body.window_days).toBe(30);
  });

  it("threads scale_factor + windowDays through to the body", async () => {
    const { fetchImpl, calls } = makeFakeFetch({
      body: { ...FAKE_PROJECT_RESPONSE, requests_in_window: 60000 },
    });
    const advisor = new ModelAdvisor({
      baseUrl: "https://test.eden.local",
      fetchImpl,
    });
    const proj = await advisor.project("org_123", {
      current: { provider: "openai", modelId: "gpt-4o" },
      candidate: { provider: "openai", modelId: "gpt-4o-mini" },
      scaleFactor: 2.0,
    });
    expect(proj.requestsInWindow).toBe(60000);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.scale_factor).toBe(2.0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────

describe("ModelAdvisor configuration", () => {
  it("strips a trailing slash from baseUrl", () => {
    const advisor = new ModelAdvisor({ baseUrl: "https://test.example.com/" });
    // We can't read baseUrl directly (it's private), but we can
    // verify it via the URL it constructs in a request.
    const { fetchImpl, calls } = makeFakeFetch({ body: FAKE_COMPARE_RESPONSE });
    advisor["fetchImpl"] = fetchImpl;
    advisor["apiKey"] = "x";
    advisor["orgId"] = "x";
    void advisor.compare(
      "o",
      { provider: "p", modelId: "m" },
      { provider: "p", modelId: "m" },
    );
    // The first call uses the no-trailing-slash form.
    expect(calls[0]!.url.startsWith("https://test.example.com/orgs/")).toBe(true);
  });

  it("sends Authorization header when apiKey is set", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ body: FAKE_COMPARE_RESPONSE });
    const advisor = new ModelAdvisor({
      apiKey: "sk-test",
      baseUrl: "https://test.eden.local",
      fetchImpl,
    });
    await advisor.compare(
      "org_123",
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "openai", modelId: "gpt-4o-mini" },
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-test");
  });

  it("omits Authorization header when apiKey is empty", async () => {
    const { fetchImpl, calls } = makeFakeFetch({ body: FAKE_COMPARE_RESPONSE });
    const advisor = new ModelAdvisor({
      baseUrl: "https://test.eden.local",
      fetchImpl,
    });
    await advisor.compare(
      "org_123",
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "openai", modelId: "gpt-4o-mini" },
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});


// ─────────────────────────────────────────────────────────────────────
// SDK config fallback (parity with Python ModelAdvisor)
// ─────────────────────────────────────────────────────────────────────

describe("ModelAdvisor SDK config fallback", () => {
  it("falls back to SDK config apiKey when no explicit apiKey given", async () => {
    // Configure the default SDK client with an apiKey; then build
    // a ModelAdvisor without an explicit apiKey and verify the
    // Authorization header is populated from the SDK config. The
    // previous TS implementation only looked at the explicit
    // ``opts.apiKey`` and left the Authorization empty, so a
    // caller that did ``configure({ apiKey })`` and then
    // ``new ModelAdvisor()`` got 401s on every call.
    const { getDefaultClient, resetDefaultClient } = await import(
      "../src/client.js"
    );
    resetDefaultClient();
    const sdk = getDefaultClient();
    sdk.configure({
      orgId: "org_cfg",
      apiKey: "sk-cfg",
      baseUrl: "https://cfg.example.com",
    });

    const { fetchImpl, calls } = makeFakeFetch({ body: FAKE_COMPARE_RESPONSE });
    const advisor = new ModelAdvisor({ fetchImpl });
    await advisor.compare(
      "org_123",
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "openai", modelId: "gpt-4o-mini" },
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-cfg");
    expect(advisor.orgId).toBe("org_cfg");
    expect(calls[0]!.url.startsWith("https://cfg.example.com/orgs/")).toBe(
      true,
    );

    // Restore the singleton so other tests aren't affected.
    resetDefaultClient();
  });

  it("explicit opts always win over SDK config fallback", async () => {
    const { getDefaultClient, resetDefaultClient } = await import(
      "../src/client.js"
    );
    resetDefaultClient();
    const sdk = getDefaultClient();
    sdk.configure({
      orgId: "org_cfg",
      apiKey: "sk-cfg",
      baseUrl: "https://cfg.example.com",
    });

    const { fetchImpl, calls } = makeFakeFetch({ body: FAKE_COMPARE_RESPONSE });
    const advisor = new ModelAdvisor({
      apiKey: "sk-explicit",
      orgId: "org_explicit",
      baseUrl: "https://explicit.example.com",
      fetchImpl,
    });
    await advisor.compare(
      "org_123",
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "openai", modelId: "gpt-4o-mini" },
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-explicit");
    expect(advisor.orgId).toBe("org_explicit");
    expect(calls[0]!.url.startsWith("https://explicit.example.com/orgs/")).toBe(
      true,
    );

    resetDefaultClient();
  });
});
