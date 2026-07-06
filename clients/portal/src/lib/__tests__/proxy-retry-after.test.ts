// @vitest-environment jsdom
/**
 * Tests for the ``retryAfterMs`` helper that lives in
 * ``@/lib/proxy`` (extracted from ``@/lib/api`` during the F36
 * refactor). Both the JSON-fetch path (``api.getMe`` etc.) and
 * the SSE handshake path (catch-all proxy) consume the same
 * helper, so we lock the behaviour here once.
 */
import { describe, expect, it } from "vitest";
import { retryAfterMs, RETRY_AFTER_DEFAULT_MS } from "@/lib/proxy";

function makeResp(retryAfter: string | null): Response {
  const headers: Record<string, string> = {};
  if (retryAfter !== null) headers["Retry-After"] = retryAfter;
  return new Response("", { status: 429, headers });
}

describe("retryAfterMs", () => {
  it("returns null when Retry-After is absent", () => {
    expect(retryAfterMs(makeResp(null))).toBeNull();
  });

  it("parses delta-seconds integers", () => {
    expect(retryAfterMs(makeResp("5"))).toBe(5_000);
    expect(retryAfterMs(makeResp("0"))).toBe(0);
    expect(retryAfterMs(makeResp("1"))).toBe(1_000);
  });

  it("caps delta-seconds at 60s", () => {
    expect(retryAfterMs(makeResp("120"))).toBe(60_000);
    expect(retryAfterMs(makeResp("99999"))).toBe(60_000);
  });

  it("parses HTTP-date form", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = retryAfterMs(makeResp(future));
    expect(ms).not.toBeNull();
    // Within a small tolerance of 10 s in the future; allow
    // +/- 1 s for clock drift during the test.
    expect(ms).toBeGreaterThan(8_000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("clamps past dates to 0 (immediate) instead of returning negative", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(retryAfterMs(makeResp(past))).toBe(0);
  });

  it("returns null on unparseable garbage", () => {
    expect(retryAfterMs(makeResp("not-a-number-or-date"))).toBeNull();
  });

  it("RETRY_AFTER_DEFAULT_MS is 5 seconds", () => {
    expect(RETRY_AFTER_DEFAULT_MS).toBe(5_000);
  });
});
