/**
 * Wave 15.3 CI pin: webhook-invalidated GET. Not a retune of upstream-rename
 * (that world is a field rename state→conclusion).
 *
 *   bun test benchmarks/campaign/webhook-get.test.ts
 */
import { describe, expect, test } from "bun:test";
import { WEBHOOK_DROPPED_COPY, WEBHOOK_WAITING_COPY } from "../../apps/site/src/webhook";
import { REFRESH_WAITING_COPY as canaryCopy } from "../../apps/site/src/canary";
import { EXPECT, GET_URL, runWebhookGet } from "./webhook-get";

const TIMEOUT = 30_000;

describe("rotation: webhook-invalidated GET (Wave 15.3)", () => {
  test("pre-registered expect is a webhook-invalidated GET, not upstream-rename", () => {
    // expect: webhook-invalidated GET misses after drop; live stays On; not a field rename.
    console.log(`expect: ${EXPECT}`);
    expect(EXPECT).toContain("webhook-invalidated GET");
    expect(EXPECT).toContain("miss after invalidate");
    expect(EXPECT.toLowerCase()).not.toMatch(/upstream-rename/);
    expect(EXPECT).not.toMatch(/state→conclusion/);
    expect(GET_URL).toContain("/comments");
  });

  test("knock copy: drift keeps field-rename; webhook drop does not", () => {
    expect(canaryCopy).toBe(
      "The outside world renamed a field. A replacement is waiting. The live tool is unchanged until you Approve.",
    );
    expect(WEBHOOK_WAITING_COPY).toContain("unchanged until you Approve");
    expect(WEBHOOK_WAITING_COPY).not.toMatch(/renamed a field/);
    expect(WEBHOOK_DROPPED_COPY).not.toMatch(/renamed a field/);
    expect(WEBHOOK_DROPPED_COPY).not.toMatch(/replacement is waiting/);
  });

  test(
    "named GET hits, webhook drops key, next read misses; live stays On",
    async () => {
      const run = await runWebhookGet({ tag: "rot" });
      expect(run.expect).toBe(EXPECT);
      expect(run.hitsBefore).toBe(1);
      expect(run.hitsAfter).toBe(0);
      expect(run.playHitsAfter).toBe(0);
      expect(run.dropped.length).toBeGreaterThan(0);
      expect(run.liveState).toBe("on");
      expect(run.message).toBe(WEBHOOK_DROPPED_COPY);
      expect(run.message).not.toMatch(/renamed a field/);
      expect(run.publicDropped).toBe(true);
    },
    TIMEOUT,
  );
});
