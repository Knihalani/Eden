/**
 * The fixture arms (A5 §4): CueBench-code and the policy triggers on the R1 fixture (+ R8's `test_nim`), the
 * alias-batch rule, and the scale arms on the memory-scale bench's 20k-row world. All plant rows through
 * `eden memory remember` (cuebench.ts) and ask every cue through the hooks.
 *
 * CI runs a fixed subset of each split (the first cues of every category, by id); `--scale full` runs them all.
 */
import {
  ALIASES,
  askCue,
  benchWorld,
  fir,
  isNegative,
  isPolicyMemory,
  memories,
  memoryRows,
  nimCues,
  perCategory,
  plant,
  precisionByCategory,
  r1Cues,
  recallAt4,
  share,
  show,
  type BenchCue,
  type CueResult,
} from "./cuebench";
import { check, jsonOut, type Arm, type ArmRun, type Check } from "./kit";
import { scaleArm } from "./scale";

/** Plants the R1 memories in a fresh world and asks `cues`; undefined when nothing could be planted. */
async function bench(
  run: ArmRun,
  cues: readonly BenchCue[],
): Promise<{ results: CueResult[]; detail: string } | undefined> {
  const spec = benchWorld();
  const world = run.world(spec);
  const planted = plant(run, world, memoryRows(world));
  if (!planted || planted.remembered !== planted.rows) return undefined;
  const pool = memories();
  const results: CueResult[] = [];
  for (const cue of cues) results.push(await askCue(world, spec, cue, pool));
  return { results, detail: `${planted.remembered} rows planted` };
}

const NOT_PLANTED = "`eden memory remember --jsonl -` planted no rows (no answer in the contract's shape)";

const subset = (run: ArmRun, cues: readonly BenchCue[], n: number) =>
  run.options.scale === "full" ? [...cues] : perCategory(cues, n);

const cuebenchCode: Arm = {
  id: "cuebench-code",
  flagged: true,
  async run(run) {
    const r1 = subset(
      run,
      r1Cues().filter((cue) => cue.split === "test"),
      3,
    );
    const nim = subset(run, nimCues(), 3);
    const outcome = await bench(run, [...r1, ...nim]);
    if (!outcome) return ["planted", "recall", "fir"].map((id) => check(id, false, NOT_PLANTED));
    const ofR1 = outcome.results.filter((result) => result.cue.split === "test");
    const ofNim = outcome.results.filter((result) => result.cue.split === "test_nim");
    const recall = recallAt4(ofR1);
    const falseInjects = fir(ofR1);
    const reported =
      `test_nim: paraphrase recall@4 ${show(recallAt4(ofNim.filter((r) => r.cue.cat === "nim-para")))}, ` +
      `negatives FIR ${show(fir(ofNim))}; precision ${JSON.stringify(precisionByCategory(ofR1))}`;
    return [
      check("planted", true, outcome.detail),
      check("recall", share(recall) >= 0.5, `R1 test recall@4 ${show(recall)}; gate ≥ 0.50. ${reported}`),
      check("fir", share(falseInjects) <= 0.075, `R1 test FIR ${show(falseInjects)}; gate ≤ 7.5%`),
    ];
  },
};

const policyTrigger: Arm = {
  id: "policy-trigger",
  flagged: true,
  async run(run) {
    const test = r1Cues().filter((cue) => cue.split === "test");
    const policy = subset(
      run,
      test.filter((cue) => cue.cat === "policy"),
      5,
    );
    const otherPositives = subset(
      run,
      test.filter((cue) => !isNegative(cue) && cue.cat !== "policy"),
      1,
    );
    const negatives = subset(run, test.filter(isNegative), 2);
    const held = subset(
      run,
      nimCues().filter((cue) => cue.cat === "nim-policy"),
      3,
    );
    const outcome = await bench(run, [...policy, ...otherPositives, ...negatives, ...held]);
    if (!outcome)
      return ["planted", "policy-recall", "fir", "policy-on-positives"].map((id) => check(id, false, NOT_PLANTED));
    const of = (cues: readonly BenchCue[]) => outcome.results.filter((result) => cues.includes(result.cue));
    const recall = recallAt4(of(policy));
    const falseInjects = fir(of(negatives));
    const withPolicy = of(otherPositives).filter((result) => result.matched.some((id) => id && isPolicyMemory(id)));
    const others = { k: withPolicy.length, n: otherPositives.length };
    return [
      check("planted", true, outcome.detail),
      check(
        "policy-recall",
        share(recall) >= 0.45,
        `R1 policy recall@4 ${show(recall)}; gate ≥ 0.45. held-out nim-policy ${show(recallAt4(of(held)))}`,
      ),
      check("fir", share(falseInjects) <= 0.05, `FIR on R1 negatives ${show(falseInjects)}; gate ≤ 5%`),
      check(
        "policy-on-positives",
        share(others) <= 0.1,
        `non-policy positives with a policy bullet ${show(others)}; gate ≤ 10%`,
      ),
    ];
  },
};

/** The alias batch's verdict, when the entry point gave one: `eden memory aliases --batch FILE --json` → {kept}. */
export function readVerdict(value: unknown): { kept: boolean } | undefined {
  const kept = (value as { kept?: unknown } | undefined)?.kept;
  return typeof kept === "boolean" ? { kept } : undefined;
}

/** A5 `alias-batch`: a kept batch never raises silence-replay FIR and costs at most 0.02 annotated recall. */
export function keptOnlyIf(kept: boolean, before: CueResult[], after: CueResult[]): Check {
  const [firBefore, firAfter] = [fir(before), fir(after)];
  const [recallBefore, recallAfter] = [recallAt4(before), recallAt4(after)];
  const allowed = share(firAfter) <= share(firBefore) && share(recallAfter) >= share(recallBefore) - 0.02;
  const firs = `${show(firBefore)} → ${show(firAfter)}`;
  const recalls = `${show(recallBefore)} → ${show(recallAfter)}`;
  const detail = `kept ${kept}; FIR ${firs}; recall ${recalls}`;
  return check("kept-only-if", !kept || allowed, detail);
}

const aliasBatch: Arm = {
  id: "alias-batch",
  flagged: true,
  async run(run) {
    const test = r1Cues().filter((cue) => cue.split === "test");
    const annotated = [
      ...subset(
        run,
        test.filter((cue) => !isNegative(cue)),
        2,
      ),
      ...subset(run, test.filter(isNegative), 2),
    ];
    const heldOut = subset(
      run,
      nimCues().filter((cue) => cue.cat === "nim-para"),
      3,
    );
    const spec = benchWorld();
    const world = run.world(spec);
    const planted = plant(run, world, memoryRows(world));
    if (!planted || planted.remembered !== planted.rows) {
      return ["planted", "batch-decided", "kept-only-if"].map((id) => check(id, false, NOT_PLANTED));
    }
    const pool = memories();
    const ask = async (cues: readonly BenchCue[]) => {
      const out: CueResult[] = [];
      for (const cue of cues) out.push(await askCue(world, spec, cue, pool));
      return out;
    };
    const before = await ask([...annotated, ...heldOut]);
    const verdict = readVerdict(jsonOut(run.cli(world, ["memory", "aliases", "--batch", ALIASES, "--json"])));
    const after = await ask([...annotated, ...heldOut]);
    const of = (results: CueResult[], cues: readonly BenchCue[]) =>
      results.filter((result) => cues.includes(result.cue));
    if (!verdict) {
      const missing = "`eden memory aliases --batch FILE --json` gave no verdict in the contract's shape";
      return [
        check("planted", true, `${planted.remembered} rows`),
        check("batch-decided", false, missing),
        check("kept-only-if", false, missing),
      ];
    }
    const heldOutRecall = `${show(recallAt4(of(before, heldOut)))} → ${show(recallAt4(of(after, heldOut)))}`;
    return [
      check("planted", true, `${planted.remembered} rows`),
      check("batch-decided", true, `kept: ${verdict.kept}; held-out paraphrase recall ${heldOutRecall}`),
      keptOnlyIf(verdict.kept, of(before, annotated), of(after, annotated)),
    ];
  },
};

export const BENCH_ARMS: Arm[] = [
  cuebenchCode,
  policyTrigger,
  aliasBatch,
  scaleArm("scale-20k", 20_000),
  scaleArm("scale-1e6", 1_000_000),
];
