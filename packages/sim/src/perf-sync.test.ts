import { describe, expect, test } from "bun:test";
import { ContextPartner, ItemCache } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import { memorySteps } from "./perf-cli";
import { warmAll } from "./server";
import { IDEAL, simIndexes, sourcesFor } from "./sources";
import { buildWorld } from "./world";

describe("sim:perf synced mode (fix-s3b)", () => {
  test("memory keeps its old steps by default and takes increasing steps", () => {
    expect(memorySteps(undefined, false)).toEqual([250, 500, 1_000, 2_000]);
    expect(memorySteps(undefined, true)).toEqual([100, 250, 500]);
    expect(memorySteps("10,20", true)).toEqual([10, 20]);
    for (const bad of ["", "20,10", "0", "a", "5,5"]) expect(() => memorySteps(bad, false)).toThrow(/--steps/);
  });

  test("warmAll backfills every tracked user of the real sync, and stops at maxTicks", async () => {
    const indexes = simIndexes(buildWorld({ seed: 1_000 }));
    // The sync's per-source call budget refills on this clock: a minute passes per tick, as on a running server.
    let clock = Date.UTC(2026, 9, 27, 9);
    const now = () => clock;
    const partner = new ContextPartner({
      sources: async (scope) => sourcesFor(indexes, IDEAL, 0, scope.userId === "u1" ? 1 : 2, false),
      sourceMap: new SourceMap(":memory:"),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now,
    });
    const sync = partner.sync!;
    const scopes = ["u1", "u2"].map((userId) => ({ tenantId: "t", userId }));
    for (const sc of scopes) {
      await partner.observe({ ...sc, sessionId: `${sc.userId}#1`, at: now(), kind: "session_start", agent: "x" });
    }
    const none = await warmAll(sync, scopes, 0);
    expect(none).toMatchObject({ ticks: 0, users: 2, cold: 2 });
    const ticking = {
      tick: async () => ((clock += 60_000), sync.tick()),
      warm: (sc: (typeof scopes)[number]) => sync.warm(sc),
    };
    const done = await warmAll(ticking, scopes, 200, 1);
    expect(done.cold).toBe(0);
    expect(done.calls).toBeGreaterThan(0);
    for (const sc of scopes) expect(sync.warm(sc)).toBe(true);
  });
});
