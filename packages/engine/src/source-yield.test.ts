/**
 * `SourceYield` (`sourceYield`, D505): each source's run of live reads with nothing used, and whether an item of
 * it has ever reached the agent (the pooled rates were deleted with D603).
 */
import { describe, expect, test } from "bun:test";
import { SourceYield } from "./source-yield";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const T0 = Date.UTC(2026, 10, 10, 9);
const u1 = { tenantId: "t1", userId: "u1" };
const u2 = { tenantId: "t1", userId: "u2" };
const other = { tenantId: "t2", userId: "u1" };

describe("SourceYield", () => {
  test("a source's run grows with each read, ends when an item of it is used, and halves in a half-life", () => {
    const y = new SourceYield(WEEK);
    expect(y.run(u1, "jira", T0)).toBe(0);
    y.read(u1, ["jira", "mail"], T0);
    y.read(u1, ["jira"], T0);
    expect(y.run(u1, "jira", T0)).toBe(2);
    expect(y.run(u1, "mail", T0)).toBe(1);
    expect(y.run(u1, "jira", T0 + WEEK)).toBeCloseTo(1, 6);
    y.read(u1, ["jira"], T0 + WEEK);
    expect(y.run(u1, "jira", T0 + WEEK)).toBeCloseTo(2, 6);
    y.used(u1, ["jira"], T0 + WEEK);
    expect(y.run(u1, "jira", T0 + WEEK)).toBe(0);
    expect(y.hasYielded(u1, "jira")).toBe(true);
    expect(y.hasYielded(u1, "mail")).toBe(false);
    // A read after a use starts a new run and keeps what the source earned.
    y.read(u1, ["jira"], T0 + WEEK);
    expect(y.run(u1, "jira", T0 + WEEK)).toBe(1);
    expect(y.hasYielded(u1, "jira")).toBe(true);
  });

  test("state is per tenant and user, and forget drops a source or the user", () => {
    const y = new SourceYield(WEEK);
    const ids = Array.from({ length: 60 }, (_, k) => `n-${k}`);
    y.read(u1, ids, T0);
    y.used(u1, ["mail"], T0);
    expect(y.run(u2, "n-0", T0)).toBe(0);
    expect(y.run(other, "n-0", T0)).toBe(0);
    expect(y.hasYielded(other, "mail")).toBe(false);
    expect(y.size(u2)).toBe(0);
    y.forget(u1, "n-0");
    expect(y.run(u1, "n-0", T0)).toBe(0);
    expect(y.run(u1, "n-1", T0)).toBe(1);
    y.forget(u1);
    expect(y.size(u1)).toBe(0);
    expect(y.hasYielded(u1, "mail")).toBe(false);
  });

  test("a tenant at its user cap drops its own oldest user, never one of a tenant whose name it prefixes", () => {
    const y = new SourceYield(WEEK);
    const nested = { tenantId: "a/b", userId: "x" };
    y.read(nested, ["s"], T0);
    for (let i = 0; i < 1_001; i++) y.read({ tenantId: "a", userId: `u${i}` }, ["s"], T0);
    expect(y.size(nested)).toBe(1);
    expect(y.size({ tenantId: "a", userId: "u0" })).toBe(0);
    expect(y.size({ tenantId: "a", userId: "u1000" })).toBe(1);
  });

  test("a user's sources are bounded: the least recently read is dropped", () => {
    const y = new SourceYield(WEEK);
    y.read(
      u1,
      Array.from({ length: 4_200 }, (_, k) => `s-${k}`),
      T0,
    );
    expect(y.size(u1)).toBe(4_096);
    expect(y.run(u1, "s-0", T0)).toBe(0);
    expect(y.run(u1, "s-4199", T0)).toBe(1);
  });
});
