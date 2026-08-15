/**
 * Tests for `src/capture.ts` — bounded capture policy.
 *
 * Mirrors `sdk/python/tests/test_capture.py`. Covers the three
 * `captureMode` values (`bounded` / `full` / `metrics_only`), the
 * error/slow bypass, and the metadata stamped onto `attributes` so a
 * truncated payload is never indistinguishable from a short one on
 * the wire.
 */

import { describe, expect, it } from "bun:test";
import {
  CAPTURE_MODE_ATTR,
  ORIGINAL_BYTES_ATTR,
  TRUNCATED_ATTR,
  captureRequestResponse,
  captureValue,
  limitsFromConfig,
  stampCaptureAttributes,
  truncateText,
  type CaptureLimits,
} from "../src/capture.js";

// ── truncateText ────────────────────────────────────────────────────

describe("truncateText", () => {
  it("leaves a short string unchanged", () => {
    const { text, truncated, originalBytes } = truncateText("short string", 1024);
    expect(text).toBe("short string");
    expect(truncated).toBe(false);
    expect(originalBytes).toBe(Buffer.byteLength("short string", "utf8"));
  });

  it("shortens a long string and keeps both head and tail", () => {
    const s = "HEAD".repeat(100) + "MIDDLE".repeat(1000) + "TAIL".repeat(100);
    const { text, truncated, originalBytes } = truncateText(s, 256);
    expect(truncated).toBe(true);
    expect(originalBytes).toBe(Buffer.byteLength(s, "utf8"));
    expect(text.startsWith("HEAD")).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(text).toContain("…[eden:truncated");
  });

  it("reports the correct omitted byte count in the marker", () => {
    const s = "x".repeat(10_000);
    const { text, truncated, originalBytes } = truncateText(s, 100);
    expect(truncated).toBe(true);
    expect(originalBytes).toBe(10_000);
    expect(text).toContain(`${originalBytes - 100}b`);
  });

  it("drops everything for a non-positive budget", () => {
    const { text, truncated, originalBytes } = truncateText("hello", 0);
    expect(text).toBe("");
    expect(truncated).toBe(true);
    expect(originalBytes).toBe(5);
  });

  it("never truncates an empty string", () => {
    const { text, truncated, originalBytes } = truncateText("", 0);
    expect(text).toBe("");
    expect(truncated).toBe(false);
    expect(originalBytes).toBe(0);
  });

  it("never throws on a multibyte boundary cut", () => {
    const s = "🎉".repeat(500);
    const { truncated, text } = truncateText(s, 37);
    expect(truncated).toBe(true);
    expect(typeof text).toBe("string");
  });
});

// ── captureValue: bounded mode ──────────────────────────────────────

describe("captureValue bounded mode", () => {
  it("truncates a long string field", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 32, slowThresholdMs: 5000 };
    const result = captureValue("y".repeat(1000), { limits });
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(1000);
    expect(result.mode).toBe("bounded");
    expect(Buffer.byteLength(result.value as string, "utf8")).toBeLessThan(1000);
  });

  it("leaves a short string untouched", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 8192, slowThresholdMs: 5000 };
    const result = captureValue("hi", { limits });
    expect(result.truncated).toBe(false);
    expect(result.value).toBe("hi");
    expect(result.originalBytes).toBe(2);
  });

  it("walks nested structures, leaving non-string scalars untouched", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 16, slowThresholdMs: 5000 };
    const value = {
      messages: [
        { role: "system", content: "s".repeat(500) },
        { role: "user", content: "short" },
      ],
      temperature: 0.7,
      n: 1,
    };
    const result = captureValue(value, { limits });
    expect(result.truncated).toBe(true);
    const out = result.value as typeof value;
    expect(out.messages.length).toBe(2);
    expect(out.temperature).toBe(0.7);
    expect(out.n).toBe(1);
    expect(out.messages[0].content.length).toBeLessThan(500);
    expect(out.messages[1].content).toBe("short");
  });

  it("preserves undefined vs null identity", () => {
    for (const mode of ["bounded", "full", "metrics_only"] as const) {
      const limits: CaptureLimits = { mode, maxStringBytes: 16, slowThresholdMs: 5000 };
      expect(captureValue(undefined, { limits }).value).toBeUndefined();
      expect(captureValue(null, { limits }).value).toBeNull();
    }
  });
});

// ── captureValue: error / slow bypass ───────────────────────────────

describe("captureValue error/slow bypass", () => {
  it("keeps full content on error", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 8, slowThresholdMs: 5000 };
    const long = "z".repeat(10_000);
    const result = captureValue(long, { hasError: true, limits });
    expect(result.truncated).toBe(false);
    expect(result.value).toBe(long);
  });

  it("keeps full content on a slow call", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 8, slowThresholdMs: 5000 };
    const long = "w".repeat(10_000);
    const result = captureValue(long, { durationMs: 5_001, limits });
    expect(result.truncated).toBe(false);
    expect(result.value).toBe(long);
  });

  it("still truncates at exactly the slow threshold (strictly-greater-than bypass)", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 8, slowThresholdMs: 5000 };
    const result = captureValue("w".repeat(10_000), { durationMs: 5_000, limits });
    expect(result.truncated).toBe(true);
  });

  it("truncates a fast, successful call", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 8, slowThresholdMs: 5000 };
    const result = captureValue("v".repeat(10_000), { durationMs: 10, limits });
    expect(result.truncated).toBe(true);
  });
});

// ── captureValue: full / metrics_only modes ─────────────────────────

describe("captureValue full/metrics_only modes", () => {
  it("full mode never truncates, even when huge", () => {
    const limits: CaptureLimits = { mode: "full", maxStringBytes: 8, slowThresholdMs: 5000 };
    const long = "a".repeat(200_000);
    const result = captureValue(long, { limits });
    expect(result.truncated).toBe(false);
    expect(result.value).toBe(long);
    expect(result.mode).toBe("full");
  });

  it("metrics_only drops content entirely", () => {
    const limits: CaptureLimits = { mode: "metrics_only", maxStringBytes: 8192, slowThresholdMs: 5000 };
    const result = captureValue({ messages: [{ content: "hi" }] }, { limits });
    expect(result.value).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.mode).toBe("metrics_only");
  });

  it("metrics_only wins even on error", () => {
    const limits: CaptureLimits = { mode: "metrics_only", maxStringBytes: 8192, slowThresholdMs: 5000 };
    const result = captureValue("secret prompt", { hasError: true, limits });
    expect(result.value).toBeNull();
  });
});

// ── stampCaptureAttributes ───────────────────────────────────────────

describe("stampCaptureAttributes", () => {
  it("marks truncated=true when any side truncated, and sums bytes", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 8, slowThresholdMs: 5000 };
    const req = captureValue("short", { limits });
    const resp = captureValue("y".repeat(1000), { limits });
    const attrs: Record<string, unknown> = {};
    stampCaptureAttributes(attrs, req, resp);
    expect(attrs[TRUNCATED_ATTR]).toBe("true");
    expect(attrs[ORIGINAL_BYTES_ATTR]).toBe(String(5 + 1000));
    expect(attrs[CAPTURE_MODE_ATTR]).toBe("bounded");
  });

  it("marks truncated=false when neither side truncated", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 8192, slowThresholdMs: 5000 };
    const req = captureValue("short req", { limits });
    const resp = captureValue("short resp", { limits });
    const attrs: Record<string, unknown> = {};
    stampCaptureAttributes(attrs, req, resp);
    expect(attrs[TRUNCATED_ATTR]).toBe("false");
  });

  it("stamps string values for wire parity with the Python SDK", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 8, slowThresholdMs: 5000 };
    const result = captureValue("z".repeat(1000), { limits });
    const attrs: Record<string, unknown> = {};
    stampCaptureAttributes(attrs, result);
    for (const v of Object.values(attrs)) {
      expect(typeof v).toBe("string");
    }
  });

  it("is a no-op with no results", () => {
    const attrs: Record<string, unknown> = { existing: "1" };
    stampCaptureAttributes(attrs);
    expect(attrs).toEqual({ existing: "1" });
    expect(attrs[TRUNCATED_ATTR]).toBeUndefined();
  });
});

// ── captureRequestResponse ───────────────────────────────────────────

describe("captureRequestResponse", () => {
  it("combines both sides and returns capture attrs", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 16, slowThresholdMs: 5000 };
    const { requestPayload, responsePayload, captureAttrs } = captureRequestResponse(
      { messages: [{ content: "r".repeat(500) }] },
      { choices: [{ message: { content: "o".repeat(500) } }] },
      { durationMs: 5, limits },
    );
    expect(
      (
        (requestPayload as { messages: { content: string }[] }).messages[0].content
      ).length,
    ).toBeLessThan(500);
    expect(
      (
        (responsePayload as { choices: { message: { content: string } }[] }).choices[0]
          .message.content
      ).length,
    ).toBeLessThan(500);
    expect(captureAttrs[TRUNCATED_ATTR]).toBe("true");
  });

  it("keeps both sides full on error", () => {
    const limits: CaptureLimits = { mode: "bounded", maxStringBytes: 16, slowThresholdMs: 5000 };
    const longReq = { messages: [{ content: "r".repeat(5000) }] };
    const longResp = { choices: [{ message: { content: "o".repeat(5000) } }] };
    const { requestPayload, responsePayload, captureAttrs } = captureRequestResponse(
      longReq,
      longResp,
      { error: "boom", durationMs: 5, limits },
    );
    expect(requestPayload).toEqual(longReq);
    expect(responsePayload).toEqual(longResp);
    expect(captureAttrs[TRUNCATED_ATTR]).toBe("false");
  });
});

// ── limitsFromConfig ─────────────────────────────────────────────────

describe("limitsFromConfig", () => {
  it("reads captureMode and maxStringBytes from a resolved config", () => {
    const limits = limitsFromConfig({ captureMode: "full", captureMaxStringBytes: 123 });
    expect(limits.mode).toBe("full");
    expect(limits.maxStringBytes).toBe(123);
  });

  it("falls back to bounded for an invalid mode", () => {
    const limits = limitsFromConfig({ captureMode: "not-a-real-mode" });
    expect(limits.mode).toBe("bounded");
  });

  it("falls back to env defaults for an absent config", () => {
    const limits = limitsFromConfig(undefined);
    expect(["bounded", "full", "metrics_only"]).toContain(limits.mode);
    expect(limits.maxStringBytes).toBeGreaterThan(0);
  });

  it("falls back to the default max bytes for a non-positive value", () => {
    const limits = limitsFromConfig({ captureMode: "bounded", captureMaxStringBytes: 0 });
    expect(limits.maxStringBytes).toBe(8192);
  });
});
