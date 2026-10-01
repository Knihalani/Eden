/**
 * Campaign edge cases: end-to-end angles the unit suites do not cover.
 * These run the REAL wrap -> compile -> shadow -> steer path against the
 * campaign worlds, and fail on any correctness violation no matter how good
 * the performance looks.
 *
 * Run via `bun test benchmarks` (wired into scripts/test.sh).
 */
import { describe, expect, test } from "bun:test";
import { Session, type WorldFactory } from "./session";
import {
  DESK_IDS,
  INCIDENT_KEYS,
  ORDER_IDS,
  blockSeed,
  createDesk,
  createEtl,
  createIncident,
  createOrders,
  createResearch,
} from "./worlds";

process.env.CAMPAIGN_THINK_MS = "8";

const TEST_TIMEOUT = 120_000;
/** 12 witnesses over a 4-id pool: even with the worlds' seeded sloppiness
 * (~15% skipped steps), every id keeps >=1 clean trace in the main cluster,
 * so the compiled envelope covers all of them and the hold-out stays
 * in distribution. */
const WITNESS = 12;

/** Record witnesses, go live, return the result for assertions. */
async function liveAfter(factory: WorldFactory, pool: Array<Record<string, unknown>>) {
  const s = new Session([["w", factory]], true);
  for (let i = 0; i < WITNESS; i++) await s.stretch("w", pool[i % pool.length]!, 900 + i);
  const r = await s.goLive("w", { compile: WITNESS - 3, holdout: 3, sandbox: factory, maxGram: 26 });
  return { session: s, result: r };
}

describe("campaign lifecycle", () => {
  test(
    "desk: compiles, passes shadow, and steering serves a full stretch in one call",
    async () => {
      const pool = [...DESK_IDS].map((id) => ({ id }));
      const { result } = await liveAfter(createDesk, pool);
      expect(result.verdict).toBe("PASS");
      expect(result.program).not.toBeNull();
      expect(result.program!.sequence[0]).toBe("getAccount");

      // A fresh session with that program live resolves a witnessed goal in ONE call.
      const s2 = new Session([["desk", createDesk]], true);
      s2.addPrograms(result.program ? [result.program] : []);
      await s2.stretch("desk", { id: DESK_IDS[0] }, 7);
      const st = s2.finish();
      expect(st.violations).toEqual([]);
      expect(st.turns).toBe(1); // aware agent stops after the head call
      expect(st.completed).toBe(1);
      // Not seven raw calls: the compiled run did the work internally.
      expect(st.rawExecutions).toBeLessThan(7);
    },
    TEST_TIMEOUT,
  );

  test(
    "orders: fan-out loop world compiles or refuses loudly, never corrupts",
    async () => {
      const pool = [...ORDER_IDS].map((orderId) => ({ orderId }));
      const { result } = await liveAfter(createOrders, pool);
      if (result.program == null) {
        expect(["NO_PROGRAM", "INCONCLUSIVE", "SKIP"]).toContain(result.verdict);
        expect(result.reasons.length).toBeGreaterThan(0);
      } else {
        expect(result.verdict).toBe("PASS");
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "out-of-envelope goals fall back to raw with correct state",
    async () => {
      const { program } = await liveAfter(
        createDesk,
        [...DESK_IDS].map((id) => ({ id })),
      );
      expect(program).not.toBeNull();
      const s = new Session([["desk", createDesk]], true);
      s.addPrograms(program ? [program] : []);
      // Novel id: never witnessed, so outside the envelope.
      await s.stretch("desk", { id: "A-NOVEL-1" }, 11);
      const st = s.finish();
      expect(st.violations).toEqual([]);
      expect(st.completed).toBe(1);
      // No steering happened: all seven raw calls ran, each behind an agent turn.
      expect(st.turns).toBe(7);
      expect(st.rawExecutions).toBe(7);
    },
    TEST_TIMEOUT,
  );

  test(
    "flaky incident world keeps exactly-once mutations under steering",
    async () => {
      const pool = [...INCIDENT_KEYS].map((key) => ({ key }));
      const { program } = await liveAfter(() => createIncident(0), pool);
      const s = new Session([["incident", () => createIncident(0)]], true);
      s.addPrograms(program ? [program] : []);
      for (let i = 0; i < 4; i++) {
        await s.stretch("incident", pool[i % pool.length]!, 300 + i);
      }
      expect(s.finish().violations).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "oblivious agents are never corrupted by suppressed sibling calls",
    async () => {
      const pool = [...DESK_IDS].map((id) => ({ id }));
      const { program } = await liveAfter(createDesk, pool);
      const s = new Session([["desk", createDesk]], true, { aware: false });
      s.addPrograms(program ? [program] : []);
      await s.stretch("desk", { id: DESK_IDS[1] }, 21);
      const st = s.finish();
      expect(st.violations).toEqual([]);
      // Every call the oblivious agent issued still cost its turn.
      expect(st.turns).toBe(7);
    },
    TEST_TIMEOUT,
  );
});

describe("campaign edge surfaces", () => {
  test(
    "compile refuses garbage traces instead of emitting junk programs",
    async () => {
      const s = new Session([["etl", () => createEtl(3)]], true);
      // One incomplete trace only: nothing to compile, nothing to shadow.
      await s.stretch("etl", { run: "R-X" }, 5);
      const r = await s.goLive("etl", { compile: 3, holdout: 3, sandbox: () => createEtl(3) });
      expect(r.program).toBeNull();
      expect(["SKIP", "NO_PROGRAM", "INCONCLUSIVE"]).toContain(r.verdict);
    },
    TEST_TIMEOUT,
  );

  test(
    "research world (many reads + island + one write) goes live safely",
    async () => {
      const pool = [
        { topic: "auth-flow" },
        { topic: "queue-retry" },
        { topic: "cache-stampede" },
        { topic: "retry-storms" },
      ];
      const { session, result } = await liveAfter(createResearch, pool);
      if (result.program) {
        expect(result.verdict).toBe("PASS");
        const s2 = new Session([["research", createResearch]], true);
        s2.addPrograms([result.program]);
        await s2.stretch("research", { topic: "auth-flow" }, 33);
        expect(s2.finish().violations).toEqual([]);
      } else {
        expect(session.total.violations).toEqual([]);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "mixed-world session keeps per-world attribution separate",
    async () => {
      const s = new Session(
        [
          ["desk", createDesk],
          ["orders", createOrders],
          ["incident", () => createIncident(0)],
        ],
        false,
      );
      await s.stretch("desk", { id: DESK_IDS[2] }, 41);
      await s.stretch("orders", { orderId: ORDER_IDS[0] }, 42);
      await s.stretch("incident", { key: INCIDENT_KEYS[0] }, 43);
      const st = s.finish();
      expect(st.violations).toEqual([]);
      expect(st.completed).toBe(3);
      expect(blockSeed("a", 1)).not.toBeNaN();
    },
    TEST_TIMEOUT,
  );
});
