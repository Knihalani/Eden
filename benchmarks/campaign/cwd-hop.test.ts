/**
 * Wave 17.1 CI pin: cwd-relative remainder hop on the live Claude curl path.
 * Not a retune of post-batch (that world uses the same absolute string).
 *
 *   bun test benchmarks/campaign/cwd-hop.test.ts
 *
 * Pre-registered expect: `EXPECT` in cwd-hop.ts (ROADMAP §4.9).
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ABSOLUTE, CWD, EXPECT, RELATIVE, probeCwdHop } from "./cwd-hop";

const TIMEOUT = 30_000;

describe("rotation: cwd-relative remainder hop (Wave 17.1)", () => {
  test("pre-registered expect is a cwd-hop world, not a retune of post-batch", () => {
    // expect: cwd-hop relative ./a.ts arms; abs claims; disagreeing id refuses; mixed-file takes head;
    // ../other does not; not post-batch.
    console.log(`expect: ${EXPECT}`);
    expect(EXPECT).toContain("cwd-hop");
    expect(EXPECT).toContain("./a.ts");
    expect(EXPECT).toContain("abs");
    expect(EXPECT.toLowerCase()).toContain("disagreeing id");
    expect(EXPECT.toLowerCase()).toContain("mixed-file");
    expect(EXPECT).toContain("../other");
    expect(EXPECT.toLowerCase()).not.toMatch(/post-batch.ts|retune of post-batch/);
    expect(ABSOLUTE).toBe(resolve(CWD, RELATIVE));
    expect(ABSOLUTE).toBe("/Users/me/repo/a.ts");
  });

  test(
    "relative ./a.ts arms; abs claims; disagreeing id refuses; mixed-file takes head; ../other does not",
    async () => {
      const r = await probeCwdHop();
      expect(r.expect).toBe(EXPECT);
      expect(r.via).toBe("curl");
      expect(r.batchDecision).toBeUndefined();
      expect(r.relativeVsAbsClaim).toBe(1);
      expect(r.sameStringRelativeClaim).toBe(1);
      expect(r.disagreeingIdClaim).toBe(0);
      expect(r.mixedHeadClaim).toBe(1);
      expect(r.mixedOtherClaim).toBe(0);
      expect(r.traversalClaim).toBe(0);
      expect(r.traversalAbsClaim).toBe(1);
      console.log(
        `cwd-hop: relative_vs_abs_claim=${r.relativeVsAbsClaim} same_string=${r.sameStringRelativeClaim} ` +
          `disagreeing_id=${r.disagreeingIdClaim} mixed_head=${r.mixedHeadClaim} ` +
          `mixed_other=${r.mixedOtherClaim} traversal=${r.traversalClaim} traversal_abs=${r.traversalAbsClaim}`,
      );
    },
    TIMEOUT,
  );
});
