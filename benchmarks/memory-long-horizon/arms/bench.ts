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
  recallInContext,
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

/** A negative asked in a ctx cue's situation: after its previous turn and Reads, at its scope. */
const inSituationOf = (negative: BenchCue, ctx: BenchCue): BenchCue => ({
  ...negative,
  id: `${negative.id}@${ctx.id}`,
  scope: ctx.scope,
  last_paths: ctx.last_paths,
  prev_turn: ctx.prev_turn,
});

/**
 * The situation cue on CueBench (A7 §3, D16; ROADMAP P4.1's gate): recall@4 of the R1 test split's 22 `ctx` cues,
 * whose subject only their previous turn or Reads carry, counted in context (`recallInContext`: a gold memory the
 * previous turn's own packet gave is not repeated, A4 §4), and the test negatives asked twice, bare and each in a ctx
 * cue's situation (round robin), so a busy context that made everything look relevant would show as new false
 * injects. CI asks every ctx cue and one negative of each class; `--scale full` every test negative.
 */
const cuebenchCtx: Arm = {
  id: "cuebench-ctx",
  flagged: true,
  async run(run) {
    const test = r1Cues().filter((cue) => cue.split === "test");
    const ctx = test.filter((cue) => cue.cat === "ctx");
    const bare = subset(run, test.filter(isNegative), 1);
    const situated = bare.map((negative, n) => inSituationOf(negative, ctx[n % ctx.length]!));
    const outcome = await bench(run, [...ctx, ...bare, ...situated]);
    if (!outcome) return ["planted", "ctx-recall", "fir-in-context"].map((id) => check(id, false, NOT_PLANTED));
    const of = (cues: readonly BenchCue[]) => outcome.results.filter((result) => cues.includes(result.cue));
    const recall = recallInContext(of(ctx));
    const atCue = recallAt4(of(ctx));
    const [firBare, firSituated] = [fir(of(bare)), fir(of(situated))];
    const fired = of(situated)
      .filter((result) => result.packet)
      .map((result) => result.cue.id);
    return [
      check("planted", true, outcome.detail),
      check(
        "ctx-recall",
        share(recall) >= 0.4,
        `R1 test ctx recall@4 in context ${show(recall)} (in the cue's packet ${show(atCue)}); gate ≥ 0.40`,
      ),
      check(
        "fir-in-context",
        firSituated.k <= firBare.k,
        `R1 test negatives with a packet: in a ctx cue's situation ${show(firSituated)} ${JSON.stringify(fired)}, ` +
          `bare ${show(firBare)}`,
      ),
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
      return ["planted", "recall-before", "batch-decided", "kept-only-if"].map((id) => check(id, false, NOT_PLANTED));
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
    const annotatedBefore = recallAt4(of(before, annotated));
    // A control: the store answers the annotated cues before the batch, so a plugin that never delivers cannot pass.
    const control = check(
      "recall-before",
      annotatedBefore.k > 0,
      `annotated recall@4 before the batch ${show(annotatedBefore)}`,
    );
    if (!verdict) {
      const missing = "`eden memory aliases --batch FILE --json` gave no verdict in the contract's shape";
      return [
        check("planted", true, `${planted.remembered} rows`),
        control,
        check("batch-decided", false, missing),
        check("kept-only-if", false, missing),
      ];
    }
    const heldOutRecall = `${show(recallAt4(of(before, heldOut)))} → ${show(recallAt4(of(after, heldOut)))}`;
    return [
      check("planted", true, `${planted.remembered} rows`),
      control,
      check("batch-decided", true, `kept: ${verdict.kept}; held-out paraphrase recall ${heldOutRecall}`),
      keptOnlyIf(verdict.kept, of(before, annotated), of(after, annotated)),
    ];
  },
};

export const BENCH_ARMS: Arm[] = [
  cuebenchCode,
  cuebenchCtx,
  policyTrigger,
  aliasBatch,
  scaleArm("scale-20k", 20_000),
  scaleArm("scale-1e6", 1_000_000),
];
