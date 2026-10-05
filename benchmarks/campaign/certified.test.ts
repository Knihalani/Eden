/**
 * Campaign go-live certifies without the deleted simulated-usage flag.
 */
import { describe, expect, test } from "bun:test";
import { Session } from "./session";
import { DESK_IDS, blockSeed, createDesk } from "./worlds";

// No simulated think time. Setting CAMPAIGN_THINK_MS here would be too late:
// session.ts reads it when it is imported, which happens before this line runs.
const NO_THINK = { thinkMs: 0 };

const TIMEOUT = 60_000;

describe("certified go-live (Wave 2.1)", () => {
  test(
    "goLive on createDesk PASSes without simulated provider usage",
    async () => {
      const pool = [...DESK_IDS].map((id) => ({ id }));
      const s = new Session([["desk", createDesk]], true, NO_THINK);
      for (let i = 0; i < 13; i++) {
        await s.stretch("desk", pool[i % pool.length]!, blockSeed(`cert-desk-${i}`, i));
      }
      const r = await s.goLive("desk", {
        compile: 9,
        holdout: 3,
        sandbox: createDesk,
        maxGram: 26,
      });
      expect(r.verdict).toBe("PASS");
      expect(r.program).not.toBeNull();
      expect(r.uncertified).not.toBe(true);
      expect(r.program!.manifest?.certified).toBe(true);
      expect(r.program!.manifest?.tokensEstimated).not.toBe(true);
    },
    TIMEOUT,
  );
});
