/**
 * Unscrapable-host rotation: traces without prompt_tokens stay uncertified
 * and are not installed.
 */
import { describe, expect, test } from "bun:test";
import { Session } from "./session";
import { createSilentHost, SILENT_HOST_IDS } from "./silent-host";

process.env.CAMPAIGN_THINK_MS = "0";

const TIMEOUT = 60_000;

describe("silent-host (unscrapable provider)", () => {
  test(
    "goLive does not install when traces have no prompt_tokens",
    async () => {
      const pool = [...SILENT_HOST_IDS].map((id) => ({ id }));
      const s = new Session([["silent", createSilentHost]], true, { scrapeUsage: false });
      for (let i = 0; i < 13; i++) {
        await s.stretch("silent", pool[i % pool.length]!, 400 + i);
      }
      const traces = s.slot("silent").traces;
      expect(traces.every((t) => t.prompt_tokens == null)).toBe(true);
      const r = await s.goLive("silent", {
        compile: 9,
        holdout: 3,
        sandbox: createSilentHost,
        maxGram: 26,
      });
      expect(r.program).toBeNull();
      expect(r.uncertified).toBe(true);
      expect(r.verdict).toBe("INCONCLUSIVE");
    },
    TIMEOUT,
  );
});
