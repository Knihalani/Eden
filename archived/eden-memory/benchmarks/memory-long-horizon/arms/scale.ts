/**
 * The scale arms (A5 §4 `scale-20k` / `scale-1e6`; P4.2, P6.1). The memory-scale bench's world (`hard-world.ts`:
 * 3 repos sharing one vocabulary, statements over 8 sessions with changes and distractors, filler rows) is planted
 * twice, in separate homes: once without filler (small) and once with N rows. Each test case is then asked in a
 * fresh session of its repo, through the hooks, after its previous assistant message, and scored by the bench's own
 * oracle (`hard-oracle.ts`):
 * - `gold-recall`: cases whose needs were met at N ≥ those met at the small store ("gold recall unchanged"), and
 *   the small store meets some (a control, so a silent plugin cannot pass);
 * - `silence`: packets on cases that need nothing ≤ 5% (A5 §2);
 * - `p99`: UserPromptSubmit p99 < 150 ms at N. Full scale repeats the cases to reach ≥ 1,000 samples.
 * A5's "never an unbounded bm25 on a fat term" is an implementation property; its symptom is the p99.
 *
 * CI plants 2,000 rows and asks 20 test cases (the first 15 that need slots and the first 5 that need nothing);
 * `--scale full` plants N and asks every test case.
 */
import { Oracle as HardOracle, bulletsOf as hardBullets } from "../../memory-scale/hard-oracle";
import { buildCases, buildWorld, REPOS, type HardCase, type World } from "../../memory-scale/hard-world";
import { latency } from "../harness/metrics";
import type { WorldSpec } from "../harness/world";
import { plant } from "./cuebench";
import { SUBJECTS } from "./fixtures/world";
import { check, Driver, type Arm, type ArmRun, type Check } from "./kit";

const CI_ROWS = 2_000;
const P99_SAMPLES = 1_000;

/** The CI subset of a world's test cases: 15 that need slots and 5 that need nothing, in the bench's order. */
export function ciCases(world: World): HardCase[] {
  const cases = buildCases(world, "test");
  return [
    ...cases.filter((item) => item.needs.length).slice(0, 15),
    ...cases.filter((item) => !item.needs.length).slice(0, 5),
  ];
}

const repoSpec: WorldSpec = {
  scopes: [""],
  subjects: SUBJECTS,
  projectFiles: { "CLAUDE.md": "# Project\n" },
  initialTruth: [],
  secrets: [],
  poison: [],
};

interface ScaleRun {
  met: number;
  needing: number;
  noisy: number;
  quiet: number;
  submitMs: number[];
}

/**
 * Plants a world in a home of its own (its three repos share it) and asks the cases `passes` times; undefined when
 * nothing was planted.
 */
async function plantAndAsk(run: ArmRun, world: World, cases: readonly HardCase[], passes: number, home: string) {
  const repos = new Map(REPOS.map((repo) => [repo.id, run.world(repoSpec, { projectName: repo.id, home })]));
  const first = repos.get(REPOS[0]!.id)!;
  const rows = world.events.map((event) => ({ text: event.text, cwd: repos.get(event.repo)!.projectDir }));
  const planted = plant(run, first, rows);
  if (!planted || planted.remembered !== planted.rows) return undefined;
  const oracle = new HardOracle(world);
  const out: ScaleRun = { met: 0, needing: 0, noisy: 0, quiet: 0, submitMs: [] };
  for (let pass = 0; pass < passes; pass++) {
    for (const item of cases) {
      const sim = repos.get(item.repo)!;
      const session = await Driver.start(sim, repoSpec);
      if (item.prev) await session.turn("what's next?", { reply: item.prev });
      const turn = await session.ask(item.cue, {});
      await session.end();
      const record = sim.log[turn.seq]!;
      out.submitMs.push(...record.invocations.map((call) => call.endedAt - call.startedAt));
      if (pass > 0) continue;
      const packets = sim.deliveries.filter((delivery) => delivery.seq === turn.seq).map((d) => d.content);
      const result = oracle.score(item, packets.flatMap(hardBullets), packets.length > 0);
      if (item.needs.length) {
        out.needing++;
        if (!result.fails.includes("need")) out.met++;
      } else {
        out.quiet++;
        if (result.fails.includes("silence")) out.noisy++;
      }
    }
  }
  return out;
}

/** The checks of a small and a scale run (see the header). */
export function scaleChecks(small: ScaleRun, big: ScaleRun, rows: number): Check[] {
  const p99 = big.submitMs.length ? latency(big.submitMs).p99 : Infinity;
  return [
    check("planted", true, `${rows} rows`),
    check(
      "gold-recall",
      small.met > 0 && big.met >= small.met,
      `needs met: ${small.met}/${small.needing} small, ${big.met}/${big.needing} at ${rows} rows`,
    ),
    check(
      "silence",
      big.quiet > 0 && big.noisy / big.quiet <= 0.05,
      `packets on ${big.noisy} of ${big.quiet} cases that need nothing`,
    ),
    check("p99", p99 < 150, `UserPromptSubmit p99 ${p99} ms over ${big.submitMs.length} invocations; gate < 150 ms`),
  ];
}

export function scaleArm(id: string, rows: number): Arm {
  return {
    id,
    flagged: true,
    async run(run) {
      const full = run.options.scale === "full";
      const n = full ? rows : CI_ROWS;
      const scaled = buildWorld(n);
      const cases = full ? buildCases(scaled, "test") : ciCases(scaled);
      const passes = full ? Math.ceil(P99_SAMPLES / Math.max(1, cases.length)) : 1;
      const big = await plantAndAsk(run, scaled, cases, passes, "scale");
      if (!big) {
        const missing = "`eden memory remember --jsonl -` planted no rows (no answer in the contract's shape)";
        return ["planted", "gold-recall", "silence", "p99"].map((name) => check(name, false, missing));
      }
      const small = await plantAndAsk(run, buildWorld(0), cases, 1, "small");
      return scaleChecks(small!, big, n);
    },
  };
}
