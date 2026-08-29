import { describe, expect, test } from "bun:test";
import { surfaceMode } from "@eden/wrap";
import { runJitSoak, steeringPick } from "./jit-soak";

const TIMEOUT = 120_000;

describe("Wave 11.4 JIT soak", () => {
  test("unique-work and vague transcripts surface zero schemas; verdict is printed", async () => {
    const prev = process.env.EDEN_SURFACE;
    delete process.env.EDEN_SURFACE;
    try {
      const r = await runJitSoak({ compileCampaign: false });
      expect(r.uniqueWorkSchemas).toBe(0);
      expect(r.vagueSchemas).toBe(0);
      expect(r.n).toBeGreaterThan(0);
      expect(r.lines.some((l) => l.startsWith("precision="))).toBe(true);
      expect(r.lines.some((l) => l.startsWith("verdict="))).toBe(true);
      expect(r.lines.some((l) => l.startsWith("JIT_DEFAULT="))).toBe(true);
      expect(r.uniqueWorkCents).toBe("n/a");
      if (!r.pass) {
        expect(r.lines.some((l) => l === "JIT_DEFAULT=all (soak not green)")).toBe(true);
        expect(surfaceMode()).toBe("all");
      }
    } finally {
      if (prev === undefined) delete process.env.EDEN_SURFACE;
      else process.env.EDEN_SURFACE = prev;
    }
  }, TIMEOUT);

  test("Wave 19 remeasure pins FAIL 0.789 n=38 and does not flip default", async () => {
    const prev = process.env.EDEN_SURFACE;
    delete process.env.EDEN_SURFACE;
    try {
      const r = await runJitSoak({ compileCampaign: true });
      expect(r.uniqueWorkSchemas).toBe(0);
      expect(r.vagueSchemas).toBe(0);
      expect(r.pass).toBe(false);
      expect(r.n).toBe(38);
      expect(r.precision.toFixed(3)).toBe("0.789");
      expect(r.lines).toContain("verdict=FAIL");
      expect(r.lines).toContain("JIT_DEFAULT=all (soak not green)");
      expect(r.lines).toContain("surfaceMode_unset=all");
      expect(surfaceMode()).toBe("all");
      expect(r.defaultMayFlip).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.EDEN_SURFACE;
      else process.env.EDEN_SURFACE = prev;
    }
  }, TIMEOUT);

  test("steering pick is null when the call matches nothing", () => {
    const miss = steeringPick(
      { type: "function", function: { name: "unknown_tool", arguments: "{}" } },
      [],
    );
    expect(miss).toBeNull();
  });
});
