import { expect, test } from "bun:test";
import { BUCKETS, bucketOf } from "./ids";

test("bucketOf (D992) is stable, 16 bits, separates tenant from user, and spreads users evenly", () => {
  expect(bucketOf("acme", "u1")).toBe(bucketOf("acme", "u1"));
  expect(bucketOf("acme", "u1")).not.toBe(bucketOf("acme", "u2"));
  expect(bucketOf("a", "bc")).not.toBe(bucketOf("ab", "c"));
  // Pinned: a change here moves every persisted file and every user's process (a format change, D992).
  expect([bucketOf("acme", "u1"), bucketOf("t", "")]).toEqual([56551, 32831]);
  const counts = new Uint32Array(16);
  for (let u = 0; u < 160_000; u++) {
    const b = bucketOf("t", `user-${u}`);
    expect(b >= 0 && b < BUCKETS).toBe(true);
    counts[b >> 12]!++;
  }
  for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
});
