import { describe, expect, test } from "bun:test";
import { REALISTIC } from "../sources";
import { buildWorld } from "../world";
import {
  gateSummary,
  ladderStops,
  median,
  profilesNamed,
  simResolver,
  userEventBodies,
  worldIndexes,
} from "./router-sim";

describe("router-sim helpers (audit 2026-11-06 F23)", () => {
  test("profiles: realistic is REALISTIC; the market profiles change only latency and errors", () => {
    expect(profilesNamed("realistic")).toBe(REALISTIC);
    const hosted = profilesNamed("hosted");
    expect(hosted.gmail!.latency.medianMs).toBe(800);
    expect(hosted.gmail!.errorRate).toBe(0.01);
    expect(hosted.gmail!.semantics).toBe(REALISTIC.gmail!.semantics);
    expect(hosted.gmail!.ratePerSec).toBe(REALISTIC.gmail!.ratePerSec);
    expect(profilesNamed("direct").drive!.latency.medianMs).toBe(700);
    expect(() => profilesNamed("ideal")).toThrow(/realistic, direct or hosted/);
  });

  test("the resolver keeps one set of connectors per (tenant, user), never shared", async () => {
    const indexes = worldIndexes(2);
    const { resolver, users } = simResolver(indexes, REALISTIC, 0);
    const a = await resolver({ tenantId: "t1", userId: "u1" });
    const again = await resolver({ tenantId: "t1", userId: "u1" });
    const otherUser = await resolver({ tenantId: "t1", userId: "u2" });
    const otherTenant = await resolver({ tenantId: "t2", userId: "u1" });
    expect(again).toBe(a);
    expect(a.length).toBe(Object.keys(REALISTIC).length);
    for (const s of a) {
      expect(otherUser).not.toContain(s);
      expect(otherTenant).not.toContain(s);
    }
    expect(users.size).toBe(3);
  });

  test("event bodies come from the user's own world, are valid JSON and keep the user's ids", () => {
    const world = buildWorld({ seed: 1_000 });
    const bodies = userEventBodies(world, "user-7", 2, 1);
    expect(bodies.length).toBeGreaterThan(4);
    for (const b of bodies) {
      const e = JSON.parse(b) as { userId: string; sessionId: string; kind: string };
      expect(e.userId).toBe("user-7");
      expect(e.sessionId.startsWith("user-7-")).toBe(true);
      expect(typeof e.kind).toBe("string");
    }
    expect(userEventBodies(world, "user-7", 2, 1)).toEqual(bodies); // deterministic per seed
  });

  test("median and the gate summary pair ratios by repetition", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    const s = gateSummary([
      [100, 200, 0],
      [95, 190, 50],
      [300, 300, 100],
    ]);
    expect(s.ratios).toEqual([3, 1.5, 0]); // a single arm with 0 events/s yields 0, never Infinity
    expect(s.hopRatios).toEqual([0.95, 0.95, 0]);
    expect(s.medianRatio).toBe(1.5);
    expect(s.lowestRatio).toBe(0);
    expect(s.meetsD172).toBe(false);
    expect(
      gateSummary([
        [100, 100, 100],
        [100, 100, 100],
        [160, 150, 130],
      ]).meetsD172,
    ).toBe(true);
  });

  test("the ladder stops on two steps in a row over twice the target, not on one burst (RealUse-1 E)", () => {
    expect(ladderStops([], 100)).toBe(false);
    expect(ladderStops([250], 100)).toBe(false); // one step over: may be the sync tick, keep stepping
    expect(ladderStops([90, 205], 100)).toBe(false);
    expect(ladderStops([90, 205, 80], 100)).toBe(false); // recovered
    expect(ladderStops([90, 205, 210], 100)).toBe(true);
    expect(ladderStops([150, 199], 100)).toBe(false); // over the target, not over twice it
    expect(ladderStops([201, 200], 100)).toBe(false); // exactly twice is not past it
  });
});
