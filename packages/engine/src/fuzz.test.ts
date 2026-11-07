import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "./config";
import { minimize, plan, runSeed, type Op, type Violation, type WorldOptions } from "./fuzz-world";
import { CORE_CONFIG } from "./parts";

// A seeded fuzz of the engine's state machine (`fuzz-world.ts`): random orders of events, asks, takes, source edits,
// adds, deletes with their notices, session ends, forgets and clock jumps over 2 tenants × 2 users × 2 sessions,
// with source calls answering after seeded microtask or timer turns. After every op and at the end it checks
// isolation (D9; packets, answers, citations and `explain`'s traces), redaction (D10), the data envelope (D11),
// settled deletions (D126), closed sessions, inertness of injection payloads (A10, `hostile` worlds), fail-open,
// not-twice (D13) and a packet handed out once. After every op,
// `explain` (D277) for a random session, often another user's ids or one never opened: isolation, bounded, empty for
// a closed session, content-free (no item, title, secret or question words). The shadow configuration (D282) checks
// that nothing a shadow call returned is tracked for usage. Each failure prints its seed and op log.
//
//   FUZZ_SEEDS=2000 FUZZ_OPS=60 bun test ./packages/engine/src/fuzz.test.ts    # scale up (FUZZ_FROM: first seed)
//   FUZZ_MINIMIZE=1 …                                                           # shrink a failing seed's plan
//   FUZZ_FROM=61 FUZZ_PLAN='[…]' …                                              # replay a printed (minimized) plan

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 8);
const OPS = Number(process.env.FUZZ_OPS ?? 60);
const FROM = Number(process.env.FUZZ_FROM ?? 1);
/**
 * Seeds that once failed, run with every default run in the configuration they failed in (a fixed bug stays fixed):
 * 61 and 328, "deletes-queued"; 1539, "explain-shape" (a verify trace counting other sessions' re-reads); 2577 and
 * core's 704, "not-twice" (a fast path delivery during a slow path's re-read, repeated by it). The last three: A11.
 */
const REGRESSIONS: Record<string, number[]> =
  process.env.FUZZ_SEEDS || process.env.FUZZ_PLAN ? {} : { default: [61, 328, 1539, 2577], core: [704] };
const MINIMIZE = process.env.FUZZ_MINIMIZE === "1";
const PLAN = process.env.FUZZ_PLAN ? (JSON.parse(process.env.FUZZ_PLAN) as Op[]) : null;

const CONFIGS: Record<string, WorldOptions> = {
  // What ships (D112), with a reader wired (a stub: the candidates push makes no call, D237).
  default: { config: DEFAULT_CONFIG, notTwice: true },
  // What a server with no model key runs: no reader (the candidates push runs all the same, D276).
  "default-no-key": { config: DEFAULT_CONFIG, noReader: true, notTwice: true },
  // What ships, with one source call in ten failing: every path must fail open.
  "default-flaky": { config: DEFAULT_CONFIG, failRate: 0.1, notTwice: true },
  // What ships, with tenant t1 behind the proxy's shadow mode (D282): its events and takes say `shadow`, so nothing
  // they return may be learned from; tenant t0 is live beside it.
  "default-shadow": { config: DEFAULT_CONFIG, shadowTenant: "t1", notTwice: true },
  // A10 (D305): every item carries an injection payload; the inert invariant runs. With the trials of D306 and D307
  // on, no payload's instruction words reach a handout.
  "default-hostile": { config: DEFAULT_CONFIG, hostile: true, notTwice: true },
  "default-hostile-shielded": {
    config: { ...DEFAULT_CONFIG, guardLine: true, quarantineInstructions: true },
    hostile: true,
    notTwice: true,
  },
  // Every part out (no sync, no push: a removal does not act, so the deletes check has nothing to hold).
  core: { config: CORE_CONFIG, notTwice: true },
};

/**
 * Engine bugs the fuzz found that are not fixed yet: reported with their seeds and not failed on, so a scaled run
 * shows what is new. Remove an entry with its fix.
 *
 * None listed. "deletes-queued" (a packet queued before `sourceRemoved` handed out after it; default seeds 61, 328,
 * 362, 384, 538, … at 60 ops) was fixed by `dropRemovedPending` (audit A5).
 *
 * "not-twice" at core seed 704 and default seed 2577 (60 ops), two rule paths repeating an item version in one
 * session, was fixed in `deliverChecked` (audit A11): the fast path delivered from the cache while the previous
 * request's slow path awaited a re-read, and the slow path, ranked against the ledger before that await, delivered it
 * again. The push-vs-rule form of this race is documented and exempt (cl-cl8.md, "Repeats").
 */
const KNOWN_INVARIANTS = new Set<string>();

const report = (name: string, seed: number, vs: Violation[], log: string[]) =>
  `[${name}] seed ${seed}: ${vs.length} violation(s); first at op ${vs[0]!.at}: ${vs[0]!.invariant}\n` +
  [...new Set(vs.map((v) => `  ${v.invariant}: ${v.detail}`))].slice(0, 8).join("\n") +
  `\n  ops:\n    ${log.join("\n    ")}`;

describe("engine fuzz: invariants hold under random operation orders", () => {
  for (const [name, options] of Object.entries(CONFIGS)) {
    test(`${name}: ${PLAN ? "one plan" : `${SEEDS} seeds × ${OPS} ops`}`, async () => {
      const failures: string[] = [];
      const known = new Map<string, number[]>();
      let cited = 0;
      const seeds = [...Array.from({ length: PLAN ? 1 : SEEDS }, (_, i) => FROM + i), ...(REGRESSIONS[name] ?? [])];
      for (const seed of seeds) {
        const ops = PLAN ?? plan(seed, OPS);
        const world = await runSeed(seed, ops, options);
        cited += world.citedItems;
        for (const v of world.violations) {
          if (!KNOWN_INVARIANTS.has(v.invariant)) continue;
          const seeds = known.get(v.invariant) ?? [];
          if (!seeds.includes(seed)) known.set(v.invariant, [...seeds, seed]);
        }
        const fresh = world.violations.filter((v) => !KNOWN_INVARIANTS.has(v.invariant));
        if (fresh.length === 0) continue;
        let log = world.log;
        if (MINIMIZE) {
          const small = await minimize(seed, ops, options, fresh[0]!.invariant);
          log = [...(await runSeed(seed, small, options)).log, `FUZZ_PLAN='${JSON.stringify(small)}'`];
        }
        failures.push(report(name, seed, fresh, log));
      }
      if (failures.length > 0) console.error(failures.join("\n\n"));
      for (const [inv, seeds] of known) console.warn(`[${name}] known ${inv}: seeds ${seeds.join(", ")}`);
      // The fuzz must deliver, or its invariants check nothing.
      expect(cited).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    }, 600_000);
  }
});
