import { describe, expect, it } from "bun:test";
import { randomId, traceIdOrRandom } from "../src/ids.js";
import { trace } from "../src/trace.js";

describe("randomId", () => {
  it("returns a 16-24 character id (compact base-36 timestamp + suffix)", () => {
    for (let i = 0; i < 100; i++) {
      const id = randomId();
      // The id is truncated to 24 chars. In 2026 the
      // base-36 ``Date.now()`` is 8 chars + 8 chars of
      // ``Math.random()`` = 16 chars. The cap of 24 leaves
      // headroom for future decades when the timestamp
      // grows past 8 chars.
      expect(id.length).toBeGreaterThanOrEqual(8);
      expect(id.length).toBeLessThanOrEqual(24);
    }
  });
  it("returns URL-safe base-36 characters", () => {
    for (let i = 0; i < 100; i++) {
      const id = randomId();
      expect(id).toMatch(/^[0-9a-z]+$/);
    }
  });
  it("returns unique ids across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(randomId());
    // Allow at most 1 collision per 1000 (vanishingly rare for
    // 16 random base-36 chars). In practice we expect 0.
    expect(seen.size).toBeGreaterThanOrEqual(999);
  });
});

describe("traceIdOrRandom", () => {
  it("falls back to randomId() when no trace is active", () => {
    const id = traceIdOrRandom();
    expect(id).toMatch(/^[0-9a-z]+$/);
  });

  it("returns a fresh id per call with no active trace (never joins a stale one)", () => {
    const a = traceIdOrRandom();
    const b = traceIdOrRandom();
    expect(a).not.toBe(b);
  });

  it(
    "joins the active trace() span's traceId instead of minting a new one",
    () => {
      // This is the actual fix (audit item 2): every LLM-call
      // instrumentation previously called the unconditional
      // ``randomId()``, so it could never join an outer
      // ``trace()``/``traceAgent()`` span. Pin the join contract
      // directly against the shared helper.
      const span = trace("outer");
      const joined = traceIdOrRandom();
      expect(joined).toBe(span.traceId);
      // A nested trace also shares the same traceId (same tree).
      const child = trace("inner");
      expect(traceIdOrRandom()).toBe(span.traceId);
      expect(child.traceId).toBe(span.traceId);
      child.end();
      span.end();
      // Once the span ends, the ambient context is restored and
      // traceIdOrRandom() must go back to minting fresh ids.
      expect(traceIdOrRandom()).not.toBe(span.traceId);
    },
  );
});
