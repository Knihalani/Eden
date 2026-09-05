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
        expect(surfaceMode()).toBe("jit");
      }
    } finally {
      if (prev === undefined) delete process.env.EDEN_SURFACE;
      else process.env.EDEN_SURFACE = prev;
    }
  }, TIMEOUT);

  test("Wave 22.2 pins PASS 1.000 n=38 and defaults to jit", async () => {
    const prev = process.env.EDEN_SURFACE;
    delete process.env.EDEN_SURFACE;
    try {
      const r = await runJitSoak({ compileCampaign: true });
      expect(r.uniqueWorkSchemas).toBe(0);
      expect(r.vagueSchemas).toBe(0);
      expect(r.pass).toBe(true);
      expect(r.n).toBe(38);
      expect(r.precision.toFixed(3)).toBe("1.000");
      expect(r.lines).toContain("verdict=PASS");
      expect(r.lines).toContain("JIT_DEFAULT=jit (soak green)");
      expect(r.lines).toContain("surfaceMode_unset=jit");
      expect(surfaceMode()).toBe("jit");
      expect(r.defaultMayFlip).toBe(true);
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
