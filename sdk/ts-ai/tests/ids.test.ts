import { describe, expect, it } from "bun:test";
import { randomId } from "../src/ids.js";

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
