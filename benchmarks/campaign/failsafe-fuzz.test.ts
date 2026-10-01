/**
 * Wave 1.4 / 6.3 — Failsafe property-fuzz.
 *
 * Generated programs × injected faults, asserting Eden-absent-equivalent
 * mutation outcomes (never more writes than raw; at most one per stretch).
 *
 * Fast inner loop: `failsafe fuzz: seed subset (50 cases)`
 * Scale-up: `failsafe fuzz: 10000 generated programs × faults`
 *
 * Seed: 0xF5A1 (see failsafe-gen.ts). Do not use Math.random.
 * Scheduler matrix lives in failsafe-fuzz-sched.test.ts (playback, not wrap).
 */
import { describe, expect, test } from "bun:test";
import { mulberry32 } from "@eden/measure";
import { createState, wrapTools, type ToolDef } from "@eden/wrap";
import {
  FUZZ_SEED,
  FUZZ_CONCURRENCY,
  N_CASES,
  N_FAST,
  MUTATING_TOOLS,
  TOOL_POOL,
  assertEdenAbsentEquivalent,
  buildProgram,
  buildScript,
  buildTools,
  fireOblivious,
  formatCase,
  generateCase,
  generateSuite,
  makeIsland,
  mapPool,
  type FuzzCase,
  type MutationMap,
} from "./failsafe-gen";

process.env.CAMPAIGN_THINK_MS = "1";
const TIMEOUT = 120_000;
const TIMEOUT_10K = 180_000;

async function runRaw(spec: FuzzCase): Promise<MutationMap> {
  const mutations: MutationMap = {};
  const tools = buildTools(spec, mutations);
  await fireOblivious(tools, buildScript(spec));
  return mutations;
}

async function runWrapped(spec: FuzzCase): Promise<MutationMap> {
  const mutations: MutationMap = {};
  const tools = buildTools(spec, mutations);
  const prog = buildProgram(spec);
  const state = createState({
    programs: [prog],
    ...(spec.fault === "timeout" || spec.islandBehavior === "timeout" ? { timeoutMs: 40 } : {}),
    ...(spec.islandAt != null ? { island: makeIsland(spec) } : {}),
  });
  const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;
  await fireOblivious(wrapped, buildScript(spec));
  return mutations;
}

async function runCase(spec: FuzzCase): Promise<{ raw: MutationMap; wrapped: MutationMap }> {
  const [raw, wrapped] = await Promise.all([runRaw(spec), runWrapped(spec)]);
  assertEdenAbsentEquivalent(spec, raw, wrapped);
  return { raw, wrapped };
}

describe("failsafe fuzz", () => {
  test("pin: head-tool repeat must not re-steer (case 5 / seed 0xF5A1)", async () => {
    // Minimal repro: sequence repeats the head tool at the end. Before the
    // alreadyArmed gate, the second lookup started a second compiled run and
    // duplicated every mutation (writeB:2→4, writeA:1→2).
    const spec: FuzzCase = {
      index: 5,
      id: "F-5",
      sequence: ["lookup", "audit", "writeB", "fetch", "writeA", "writeB", "lookup"],
      islandAt: 5,
      islandBehavior: "success",
      fault: "none",
      faultAt: 6,
    };
    const { raw, wrapped } = await runCase(spec);
    expect(wrapped["writeB:F-5"] ?? 0).toBeLessThanOrEqual(raw["writeB:F-5"] ?? 0);
    expect(wrapped["writeA:F-5"] ?? 0).toBeLessThanOrEqual(raw["writeA:F-5"] ?? 0);
    expect(wrapped["writeB:F-5"]).toBe(2);
    expect(wrapped["writeA:F-5"]).toBe(1);
  });

  test(
    "failsafe fuzz: seed subset (50 cases)",
    async () => {
      const cases = generateSuite(FUZZ_SEED, N_FAST);
      let divergences = 0;
      for (const spec of cases) {
        try {
          await runCase(spec);
        } catch (err) {
          divergences++;
          throw err;
        }
      }
      console.log(
        `failsafe-fuzz n=${N_FAST} divergences=${divergences} seed=0x${FUZZ_SEED.toString(16).toUpperCase()}`,
      );
      expect(divergences).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "failsafe fuzz: 10000 generated programs × faults",
    async () => {
      const t0 = performance.now();
      const cases = generateSuite(FUZZ_SEED, N_CASES);
      let divergences = 0;
      let timeouts = 0;
      const firstErr: unknown[] = [];
      for (const spec of cases) {
        if (spec.fault === "timeout") timeouts++;
      }
      await mapPool(cases, FUZZ_CONCURRENCY, async (spec) => {
        try {
          await runCase(spec);
        } catch (err) {
          divergences++;
          if (firstErr.length < 8) firstErr.push(err);
        }
      });
      const ms = Math.round(performance.now() - t0);
      console.log(
        `failsafe-fuzz n=${N_CASES} divergences=${divergences} ` +
          `seed=0x${FUZZ_SEED.toString(16).toUpperCase()} timeouts=${timeouts} ms=${ms}`,
      );
      if (firstErr[0] instanceof Error) throw firstErr[0];
      if (firstErr[0] !== undefined) throw new Error(String(firstErr[0]));
      expect(divergences).toBe(0);
      expect(timeouts).toBeLessThanOrEqual(50);
    },
    TIMEOUT_10K,
  );

  test(
    "failsafe fuzz: concurrent stretches keep exactly-once per id",
    async () => {
      const rng = mulberry32(FUZZ_SEED ^ 0xc0ff);
      const timeoutLeft = { n: 5 };
      const N = 32; // well under ARM_MAX_ENTRIES (64)
      const base = generateCase(rng, 0, timeoutLeft);
      // Shared shape; distinct entity ids.
      const specs: FuzzCase[] = Array.from({ length: N }, (_, i) => ({
        ...base,
        index: i,
        id: `C-${i}`,
        // Concurrent suite: no timeout sleeps (keep this test fast).
        fault: base.fault === "timeout" ? "none" : base.fault,
        islandBehavior: base.islandBehavior === "timeout" ? "throw" : base.islandBehavior,
      }));

      const mutations: MutationMap = {};
      // One shared tool surface; each id is a distinct stretch.
      const faultTool = specs[0]!.sequence[specs[0]!.faultAt]!;
      const tools: Record<string, ToolDef> = {};
      for (const name of TOOL_POOL) {
        tools[name] = {
          description: name,
          execute: async (args: Record<string, unknown>) => {
            if (name === faultTool && specs[0]!.fault === "throw500") throw new Error("500");
            if (name === faultTool && specs[0]!.fault === "abort") {
              const err = new Error("aborted");
              err.name = "AbortError";
              throw err;
            }
            if (MUTATING_TOOLS.has(name)) {
              const key = `${name}:${String(args.id)}`;
              mutations[key] = (mutations[key] ?? 0) + 1;
            }
            return { name, id: args.id };
          },
        };
      }

      const prog = buildProgram({ ...specs[0]!, id: "C-template", index: 9999 });
      // Program id is shared; input `id` distinguishes stretches (partial match).
      const state = createState({
        programs: [prog],
        ...(specs[0]!.islandAt != null
          ? {
              island: makeIsland({
                ...specs[0]!,
                islandBehavior: specs[0]!.islandBehavior === "timeout" ? "throw" : specs[0]!.islandBehavior,
              }),
            }
          : {}),
      });
      const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;

      await Promise.all(
        specs.map((spec) =>
          fireOblivious(
            wrapped,
            spec.sequence.map((tool, i) => ({
              tool,
              args: i === 0 ? { id: spec.id, text: `c-${spec.index}` } : { id: spec.id },
            })),
          ),
        ),
      );

      for (const spec of specs) {
        for (const tool of new Set(spec.sequence)) {
          if (!MUTATING_TOOLS.has(tool)) continue;
          const key = `${tool}:${spec.id}`;
          const n = mutations[key] ?? 0;
          const programmed = spec.sequence.filter((t) => t === tool).length;
          if (n > programmed) {
            throw new Error(
              `concurrent divergence ${key}=${n} programmed=${programmed} | ${formatCase(spec, {}, mutations)}`,
            );
          }
        }
      }
    },
    TIMEOUT,
  );
});
