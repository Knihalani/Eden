/**
 * Tests for the per-filter SDK configuration.
 *
 * Mirrors `sdk/python/tests/test_filters.py`. Covers:
 *   - PIIConfig validation + header rendering
 *   - FilterConfig dispatching to per-filter headers
 *   - EdenSDK gatewayHeaders() integration
 *   - resolvedGatewayUrl helper
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  EdenSDK,
  FILTER_NAMES,
  FilterConfig,
  PIIConfig,
  resetDefaultClient,
  resolvedGatewayUrl,
} from "../src/index.js";

describe("PIIConfig", () => {
  it("defaults to mode=redact and no disabled categories", () => {
    const c = new PIIConfig();
    expect(c.mode).toBe("redact");
    expect(c.disabledCategories).toEqual([]);
    expect(c.bypass).toBe(false);
  });

  it("rejects invalid modes", () => {
    expect(() => new PIIConfig({ mode: "bogus" as any })).toThrow(/PIIConfig.mode/);
  });

  it("accepts the three valid modes", () => {
    for (const mode of ["off", "redact", "fail_closed"] as const) {
      expect(new PIIConfig({ mode }).mode).toBe(mode);
    }
  });

  it("emits only X-PII-Mode by default", () => {
    const h = new PIIConfig().toHeaders();
    expect(h).toEqual({ "X-PII-Mode": "redact" });
  });

  it("emits X-PII-Bypass when bypass is true", () => {
    const h = new PIIConfig({ bypass: true }).toHeaders();
    expect(h["X-PII-Bypass"]).toBe("true");
    expect(h["X-PII-Mode"]).toBe("redact");
  });

  it("emits X-PII-Disabled-Categories when categories are set", () => {
    const h = new PIIConfig({
      disabledCategories: ["api_key", "url_with_creds"],
    }).toHeaders();
    expect(h["X-PII-Disabled-Categories"]).toBe("api_key,url_with_creds");
  });

  it("emits all three when fully configured", () => {
    const h = new PIIConfig({
      mode: "fail_closed",
      bypass: true,
      disabledCategories: ["ssn"],
    }).toHeaders();
    expect(h["X-PII-Mode"]).toBe("fail_closed");
    expect(h["X-PII-Bypass"]).toBe("true");
    expect(h["X-PII-Disabled-Categories"]).toBe("ssn");
  });

  it("still emits X-PII-Mode when mode=off", () => {
    const h = new PIIConfig({ mode: "off" }).toHeaders();
    expect(h["X-PII-Mode"]).toBe("off");
  });
});

describe("FilterConfig", () => {
  it("emits nothing when empty", () => {
    expect(new FilterConfig().toHeaders()).toEqual({});
  });

  it("dispatches to PIIConfig when pii is set", () => {
    const h = new FilterConfig({ pii: new PIIConfig({ mode: "fail_closed" }) }).toHeaders();
    expect(h).toEqual({ "X-PII-Mode": "fail_closed" });
  });

  it("FILTER_NAMES contains the known filter names", () => {
    expect(FILTER_NAMES).toContain("pii");
  });
});

describe("EdenSDK gatewayHeaders", () => {
  it("omits X-PII-* headers when no filter config is set", () => {
    const sdk = new EdenSDK({ orgId: "o", apiKey: "k" });
    const h = sdk.gatewayHeaders();
    expect(h["X-PII-Mode"]).toBeUndefined();
    expect(h["X-PII-Bypass"]).toBeUndefined();
    expect(h["X-PII-Disabled-Categories"]).toBeUndefined();
  });

  it("renders the process-wide filter config", () => {
    const sdk = new EdenSDK({
      orgId: "o",
      apiKey: "k",
      filters: new FilterConfig({ pii: new PIIConfig({ mode: "fail_closed" }) }),
    });
    const h = sdk.gatewayHeaders();
    expect(h["X-PII-Mode"]).toBe("fail_closed");
    expect(h["X-Org-Api-Key"]).toBe("k");
  });

  it("per-call filter override wins over process-wide", () => {
    const sdk = new EdenSDK({
      orgId: "o",
      apiKey: "k",
      filters: new FilterConfig({ pii: new PIIConfig({ mode: "redact" }) }),
    });
    expect(sdk.gatewayHeaders().filters ?? null).toBeNull();
    const h = sdk.gatewayHeaders({
      filters: new FilterConfig({ pii: new PIIConfig({ mode: "fail_closed" }) }),
    });
    expect(h["X-PII-Mode"]).toBe("fail_closed");
  });

  it("piiBypass kwarg adds X-PII-Bypass alongside process filters", () => {
    const sdk = new EdenSDK({
      orgId: "o",
      apiKey: "k",
      filters: new FilterConfig({ pii: new PIIConfig({ mode: "fail_closed" }) }),
    });
    const h = sdk.gatewayHeaders({ piiBypass: true });
    expect(h["X-PII-Bypass"]).toBe("true");
    expect(h["X-PII-Mode"]).toBe("fail_closed");
  });

  it("emits upstream-override headers when provided", () => {
    const sdk = new EdenSDK({ orgId: "o", apiKey: "k" });
    const h = sdk.gatewayHeaders({
      upstreamBaseUrl: "https://my-internal.example.com/v1",
      upstreamApiKey: "sk-internal",
      upstreamProvider: "openai",
    });
    expect(h["X-Upstream-Base-Url"]).toBe("https://my-internal.example.com/v1");
    expect(h["X-Upstream-Api-Key"]).toBe("sk-internal");
    expect(h["X-Upstream-Provider"]).toBe("openai");
  });

  it("piiBypass=false emits X-PII-Bypass: false to force redaction", () => {
    const sdk = new EdenSDK({ orgId: "o", apiKey: "k" });
    const h = sdk.gatewayHeaders({ piiBypass: false });
    expect(h["X-PII-Bypass"]).toBe("false");
  });
});

describe("resolvedGatewayUrl", () => {
  it("defaults to {baseUrl}/v1 when gatewayUrl is unset", () => {
    const sdk = new EdenSDK({ orgId: "o", apiKey: "k" });
    expect(sdk.resolvedGatewayUrl()).toBe("http://localhost:8000/v1");
  });

  it("honours an explicit gatewayUrl", () => {
    const sdk = new EdenSDK({
      orgId: "o",
      apiKey: "k",
      gatewayUrl: "https://gateway.eden.ai/v1",
    });
    expect(sdk.resolvedGatewayUrl()).toBe("https://gateway.eden.ai/v1");
  });

  it("does not double-append /v1 when baseUrl already has it", () => {
    const sdk = new EdenSDK({
      orgId: "o",
      apiKey: "k",
      baseUrl: "https://api.example.com/v1",
    });
    expect(sdk.resolvedGatewayUrl()).toBe("https://api.example.com/v1");
  });

  it("strips trailing slashes from baseUrl before appending", () => {
    const sdk = new EdenSDK({
      orgId: "o",
      apiKey: "k",
      baseUrl: "https://api.example.com/",
    });
    expect(sdk.resolvedGatewayUrl()).toBe("https://api.example.com/v1");
  });

  it("matches the standalone resolvedGatewayUrl() helper", () => {
    const sdk = new EdenSDK({ orgId: "o", apiKey: "k" });
    expect(sdk.resolvedGatewayUrl()).toBe(
      resolvedGatewayUrl(sdk.getConfig()),
    );
  });
});

afterEach(() => {
  resetDefaultClient();
});
