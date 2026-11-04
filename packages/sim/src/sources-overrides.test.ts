import { describe, expect, test } from "bun:test";
import { REALISTIC, withOverrides } from "./sources";

describe("withOverrides", () => {
  test("replaces only the named fields of the named sources", () => {
    const p = withOverrides(REALISTIC, { gmail: { latency: { medianMs: 700, sigma: 0.6 } } });
    expect(p.gmail!.latency).toEqual({ medianMs: 700, sigma: 0.6 });
    expect(p.gmail!.semantics).toBe(REALISTIC.gmail!.semantics);
    expect(p.drive).toEqual(REALISTIC.drive);
    expect(REALISTIC.gmail!.latency.medianMs).toBe(350);
  });
  test("rejects an unknown source name", () => {
    expect(() => withOverrides(REALISTIC, { gmial: { errorRate: 0 } })).toThrow(/unknown source/);
  });
});
