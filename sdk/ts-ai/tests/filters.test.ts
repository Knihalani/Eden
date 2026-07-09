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

// ── Client-side safety-net redactor ───────────────────────────────

import { redactPayload } from "../src/filters.js";

describe("redactPayload", () => {
  it("redacts emails", () => {
    const out = redactPayload("contact alice@example.com today") as string;
    expect(out).toBe("contact [REDACTED] today");
  });

  it("redacts US phone numbers", () => {
    const out = redactPayload("call (415) 555-2671 anytime") as string;
    expect(out).toBe("call [REDACTED] anytime");
  });

  it("redacts SSNs", () => {
    const out = redactPayload("SSN 123-45-6789 was on file") as string;
    expect(out).toBe("SSN [REDACTED] was on file");
  });

  it("redacts credit cards", () => {
    const out = redactPayload("card 4111 1111 1111 1111 used") as string;
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("4111 1111 1111 1111");
  });

  it("recurses into nested structures", () => {
    const payload = {
      messages: [
        { role: "user", content: "ping alice@example.com" },
        { role: "assistant", content: "ok" },
      ],
      metadata: { notes: "ssn 111-22-3333" },
    };
    const out = redactPayload(payload) as typeof payload;
    expect(out.messages[0].content).toBe("ping [REDACTED]");
    expect(out.messages[0].role).toBe("user");
    expect(out.metadata.notes).toBe("ssn [REDACTED]");
  });

  it("does not mutate the original", () => {
    const original = { text: "alice@example.com" };
    redactPayload(original);
    expect(original.text).toBe("alice@example.com");
  });

  it("leaves non-string scalars unchanged", () => {
    const out = redactPayload({ n: 42, f: 3.14, b: true, none: null });
    expect(out).toEqual({ n: 42, f: 3.14, b: true, none: null });
  });

  it("leaves short numeric IDs alone", () => {
    const out = redactPayload("order 1234 placed") as string;
    expect(out).toBe("order 1234 placed");
  });

  it("does not redact pure-digit strings as phones", () => {
    for (const raw of ["1234567890", "12345678901"]) {
      expect(redactPayload({ id: raw })).toEqual({ id: raw });
    }
  });

  it("redacts phones with separators", () => {
    for (const fmt of ["415-555-2671", "(415) 555-2671", "+1 415 555 2671", "415.555.2671"]) {
      const out = redactPayload({ phone: fmt }) as { phone: string };
      expect(out.phone).toContain("[REDACTED]");
    }
  });

  it("redacts Luhn-valid credit cards", () => {
    for (const cc of ["4111 1111 1111 1111", "5500000000000004"]) {
      const out = redactPayload({ card: cc }) as { card: string };
      expect(out.card).toContain("[REDACTED]");
    }
  });

  it("does not redact Luhn-invalid long numbers", () => {
    for (const raw of ["1234567890123", "12345678901234", "1234567890123456789"]) {
      expect(redactPayload({ id: raw })).toEqual({ id: raw });
    }
  });

  it("redacts token counts unchanged", () => {
    // The whole point: legitimate payloads with token counts
    // must not be touched.
    const out = redactPayload({ usage: { total_tokens: 1234567 } });
    expect(out).toEqual({ usage: { total_tokens: 1234567 } });
  });
});


// ── Integration test: real OpenAI / Anthropic response shapes ──────

const OPENAI_CHAT_COMPLETION = {
  id: "chatcmpl-abc123def456",
  object: "chat.completion",
  created: 1717000000,
  model: "gpt-4o-mini-2024-07-18",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content:
          "Thanks for the message. I'll follow up at " +
          "alice@example.com or call (415) 555-2671.",
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 142, completion_tokens: 38, total_tokens: 180 },
};

const ANTHROPIC_MESSAGE = {
  id: "msg_01HXYZ",
  type: "message",
  role: "assistant",
  content: [
    {
      type: "text",
      text:
        "Your account SSN 123-45-6789 was on file. " +
        "Card ending 4111 1111 1111 1111 was charged.",
    },
  ],
  model: "claude-3-5-sonnet-20241022",
  usage: { input_tokens: 87, output_tokens: 24 },
};

describe("redactPayload on realistic LLM payloads", () => {
  it("masks PII in an OpenAI chat completion and keeps structure", () => {
    const out = redactPayload(OPENAI_CHAT_COMPLETION) as typeof OPENAI_CHAT_COMPLETION;
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("alice@example.com");
    expect(flat).not.toContain("(415) 555-2671");
    expect(flat).toContain("[REDACTED]");
    expect(out.usage.prompt_tokens).toBe(142);
    expect(out.usage.completion_tokens).toBe(38);
    expect(out.model).toBe("gpt-4o-mini-2024-07-18");
    expect(out.id).toBe("chatcmpl-abc123def456");
    expect(out.choices[0].message.role).toBe("assistant");
  });

  it("masks PII in an Anthropic message and keeps structure", () => {
    const out = redactPayload(ANTHROPIC_MESSAGE) as typeof ANTHROPIC_MESSAGE;
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("123-45-6789");
    expect(flat).not.toContain("4111 1111 1111 1111");
    expect(flat).toContain("[REDACTED]");
    expect(out.usage.input_tokens).toBe(87);
    expect(out.usage.output_tokens).toBe(24);
    expect(out.model).toBe("claude-3-5-sonnet-20241022");
    expect(out.id).toBe("msg_01HXYZ");
  });

  it("masks PII in a chat request and preserves control fields", () => {
    const request = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        {
          role: "user",
          content:
            "My email is bob@example.org and my phone is " +
            "+1 415 555 9999. Please confirm.",
        },
      ],
      temperature: 0.7,
    };
    const out = redactPayload(request) as typeof request;
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("bob@example.org");
    expect(flat).not.toContain("415 555 9999");
    expect(out.messages[0].content).toBe("You are a helpful assistant.");
    expect(out.temperature).toBe(0.7);
    expect(out.model).toBe("gpt-4o-mini");
  });

  it("token counts are never redacted", () => {
    for (const n of [1, 100, 9999, 1_000_000, 1_234_567_890]) {
      expect(redactPayload({ usage: { total_tokens: n } })).toEqual({
        usage: { total_tokens: n },
      });
    }
  });
});

describe("redactPayload edge cases", () => {
  it("redacts PII in dict keys", () => {
    // Some upstream LLM SDKs stash identifiers in dict keys.
    // String keys are redacted for safety.
    const out = redactPayload({ "alice@example.com": "value" }) as Record<string, unknown>;
    expect(out["[REDACTED]"]).toBe("value");
    expect("alice@example.com" in out).toBe(false);
  });

  it("redacts PII in nested dict keys", () => {
    const out = redactPayload({ outer: { "alice@example.com": "value" } }) as {
      outer: Record<string, unknown>;
    };
    expect(out.outer["[REDACTED]"]).toBe("value");
    expect("alice@example.com" in out.outer).toBe(false);
  });

  it("handles empty and null inputs", () => {
    expect(redactPayload({})).toEqual({});
    expect(redactPayload([])).toEqual([]);
    expect(redactPayload("")).toBe("");
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(42)).toBe(42);
    expect(redactPayload(true)).toBe(true);
  });
});

describe("redactPayload key-collision disambiguation", () => {
  // Regression: the previous implementation used a naive
  // object-comprehension that silently overwrote the first
  // entry when two distinct keys redacted to the same value.
  // A payload carrying multiple PII keys (e.g. per-user
  // metrics keyed by email) lost data on every redact call.
  it("disambiguates two colliding PII keys", () => {
    const out = redactPayload({
      "alice@example.com": 5,
      "bob@example.com": 3,
    }) as Record<string, unknown>;
    expect(out["[REDACTED]"]).toBe(5);
    expect(out["[REDACTED]_2"]).toBe(3);
  });

  it("disambiguates three colliding PII keys", () => {
    const out = redactPayload({
      "a@example.com": 1,
      "b@example.com": 2,
      "c@example.com": 3,
    }) as Record<string, unknown>;
    expect(out["[REDACTED]"]).toBe(1);
    expect(out["[REDACTED]_2"]).toBe(2);
    expect(out["[REDACTED]_3"]).toBe(3);
  });

  it("passes through distinct non-PII keys untouched", () => {
    const out = redactPayload({ foo: 1, bar: 2 }) as Record<string, unknown>;
    expect(out).toEqual({ foo: 1, bar: 2 });
  });
});
