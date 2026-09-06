/**
 * Wave 3.5 CI pin: 8-witness go-live on desk (sloppy 15%) and ETL (long stretch).
 * Full four-world command: `bun benchmarks/campaign/bench-8-witness.ts`
 */
import { describe, expect, test } from "bun:test";
import { Session } from "./session";
import { DESK_IDS, blockSeed, createDesk, createEtl } from "./worlds";

process.env.CAMPAIGN_THINK_MS = "0";

const TIMEOUT = 90_000;

describe("8-witness go-live (Wave 3.5)", () => {
  test(
    "desk certifies at 8 witnesses with zero uncertified",
    async () => {
      const pool = [...DESK_IDS].map((id) => ({ id }));
      const s = new Session([["desk", createDesk]], true);
      for (let i = 0; i < 8; i++) {
        await s.stretch("desk", pool[i % pool.length]!, blockSeed(`w3-8-desk`, i));
      }
      const r = await s.goLive("desk", { compile: 5, holdout: 3, sandbox: createDesk });
      expect(r.verdict).toBe("PASS");
      expect(r.program).not.toBeNull();
      expect(r.uncertified).not.toBe(true);
      expect(r.program!.manifest?.certified).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "etl certifies at 8 witnesses without a hard-coded maxGram",
    async () => {
      const pool = ["R-S1", "R-S2", "R-S3", "R-S4"].map((run) => ({ run }));
      const factory = () => createEtl(6);
      const s = new Session([["etl", factory]], true);
      for (let i = 0; i < 8; i++) {
        await s.stretch("etl", pool[i % pool.length]!, blockSeed(`w3-8-etl`, i));
      }
      const r = await s.goLive("etl", { compile: 5, holdout: 3, sandbox: factory });
      expect(r.verdict).toBe("PASS");
      expect(r.program).not.toBeNull();
      expect(r.uncertified).not.toBe(true);
      expect((r.program!.sequence?.length ?? 0) >= 15).toBe(true);
    },
    TIMEOUT,
  );
});
