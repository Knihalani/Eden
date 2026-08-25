import { describe, expect, test } from "bun:test";
import { densifyPayload } from "./densify";

/**
 * Densification compression ratios across realistic agent payload archetypes.
 *
 * These numbers quantify how much Eden shrinks tool outputs before they enter
 * the model's context — directly translating to input-token cost savings.
 * Every archetype must achieve meaningful compression or the test flags it.
 */
describe("densification compression benchmarks", () => {
  function ratio(raw: unknown): number {
    const { raw_bytes, densified_bytes } = densifyPayload(raw);
    return raw_bytes > 0 ? densified_bytes / raw_bytes : 1;
  }

  test("uniform object arrays compress via columnar encoding", () => {
    const issues = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      title: `Issue ${i}: fix something`,
      state: i % 2 ? "open" : "closed",
      created_at: "2026-01-01T00:00:00Z",
      labels: [{ name: "bug" }],
    }));
    const r = ratio(issues);
    expect(r).toBeLessThan(0.7); // ≥30% compression from columnar layout
  });

  test("wide objects with repeated keys don't inflate", () => {
    const obj = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`field_${i}`, { value: i, type: "number" }]),
    );
    // Densify sorts keys and normalizes structure; it doesn't shrink
    // non-array payloads, but it must never inflate them.
    expect(ratio(obj)).toBeLessThanOrEqual(1);
  });

  test("deep nesting survives without corruption", () => {
    const deep = { a: { b: { c: { d: { e: "leaf" } } } } };
    const { densified, densified_bytes } = densifyPayload(deep);
    expect(densified_bytes).toBeGreaterThan(0);
    // Round-trip preserves data.
    expect(JSON.stringify(densified)).toContain("leaf");
  });

  test("ANSI-heavy CLI output compresses significantly", () => {
    const log = {
      stdout: "\x1b[32m✓\x1b[0m Pass \x1b[32m✓\x1b[0m Pass \x1b[31m✗\x1b[0m Fail\n".repeat(50),
    };
    const r = ratio(log);
    expect(r).toBeLessThan(0.5); // ANSI codes are pure overhead
  });

  test("small payloads don't inflate", () => {
    // Tiny results should not get bigger after densification.
    expect(ratio({ ok: true })).toBeLessThanOrEqual(1);
    expect(ratio([1, 2, 3])).toBeLessThanOrEqual(1);
  });
});
