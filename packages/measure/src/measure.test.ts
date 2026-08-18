import { describe, expect, test } from "bun:test";
import {
  blocksForResolution,
  decide,
  isBalanced,
  looseEquals,
  mean,
  minAchievableP,
  minDetectableEffect,
  mulberry32,
  pairDeltas,
  pairedBootstrapCI,
  pairedPermutationP,
  positionBalance,
  probit,
  requiredBlocks,
  runPlan,
  scoreRecord,
  scoreRecords,
  stdev,
  tQuantile,
  type Sample,
} from "../src/index";

const samples = (task: string, values: number[]): Sample[] =>
  values.map((value, repeat) => ({ task, repeat, value }));

/** One sample per (task, repeat) across several tasks. */
function grid(values: Record<string, number[]>): Sample[] {
  return Object.entries(values).flatMap(([task, vs]) => samples(task, vs));
}

describe("stats", () => {
  test("mean and stdev", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stdev([5])).toBe(0);
  });

  test("mulberry32 is deterministic and stays in range", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const first = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(first);
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(mulberry32(42)());
  });

  test("probit matches known quantiles", () => {
    expect(probit(0.5)).toBeCloseTo(0, 6);
    expect(probit(0.975)).toBeCloseTo(1.959964, 4);
    expect(probit(0.8)).toBeCloseTo(0.841621, 4);
    expect(probit(0.025)).toBeCloseTo(-1.959964, 4);
    expect(() => probit(0)).toThrow();
    expect(() => probit(1)).toThrow();
  });

  test("bootstrap CI brackets a clear effect and straddles zero for noise", () => {
    const clear = pairedBootstrapCI([10, 11, 9, 10, 12, 10, 11], { seed: 1 });
    expect(clear.lo).toBeGreaterThan(0);
    expect(clear.point).toBeCloseTo(10.43, 1);

    const noise = pairedBootstrapCI([-40, 55, -12, 30, -25, 18], { seed: 1 });
    expect(noise.lo).toBeLessThan(0);
    expect(noise.hi).toBeGreaterThan(0);
  });

  test("bootstrap is reproducible from its seed", () => {
    const d = [3, -1, 4, -1, 5, 9, -2, 6];
    expect(pairedBootstrapCI(d, { seed: 7 })).toEqual(pairedBootstrapCI(d, { seed: 7 }));
    expect(pairedBootstrapCI(d, { seed: 7 }).lo).not.toBe(pairedBootstrapCI(d, { seed: 8 }).lo);
  });

  test("permutation test is exact for small n and never reports p=0", () => {
    // All eight deltas the same sign: the observed split is the most extreme of
    // the 2^8 sign assignments, so p is 2/256 (both tails), not 0.
    expect(pairedPermutationP([5, 5, 5, 5, 5, 5, 5, 5])).toBeCloseTo(2 / 256, 6);
    expect(pairedPermutationP([1, -1])).toBeGreaterThan(0.5);
    expect(pairedPermutationP([])).toBe(1);
  });

  test("minDetectableEffect shrinks with n and requiredBlocks inverts it", () => {
    const small = minDetectableEffect(100, 4);
    const large = minDetectableEffect(100, 64);
    expect(large).toBeLessThan(small);
    expect(minDetectableEffect(100, 1)).toBe(Number.POSITIVE_INFINITY);
    // Round-tripping: n blocks make an effect of size MDE(n) detectable.
    const n = requiredBlocks(100, small);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(n).toBeLessThanOrEqual(5);
    expect(requiredBlocks(100, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("design", () => {
  test("interleaves arms within a block instead of running arms in phases", () => {
    const plan = runPlan({ tasks: ["t1", "t2"], arms: ["control", "eden"], repeats: 2 });
    expect(plan).toHaveLength(8);
    // Each consecutive pair is one block: same task, same repeat, both arms.
    for (let i = 0; i < plan.length; i += 2) {
      const [a, b] = [plan[i]!, plan[i + 1]!];
      expect(a.task).toBe(b.task);
      expect(a.repeat).toBe(b.repeat);
      expect(new Set([a.arm, b.arm])).toEqual(new Set(["control", "eden"]));
    }
  });

  test("counterbalances which arm goes first", () => {
    const plan = runPlan({ tasks: ["t1", "t2", "t3", "t4"], arms: ["control", "eden"] });
    const balance = positionBalance(plan);
    expect(balance.get("control")).toEqual([2, 2]);
    expect(balance.get("eden")).toEqual([2, 2]);
    expect(isBalanced(plan)).toBe(true);
  });

  test("stays balanced across odd block counts and three arms", () => {
    expect(isBalanced(runPlan({ tasks: ["a", "b", "c"], arms: ["x", "y"], repeats: 3 }))).toBe(true);
    expect(isBalanced(runPlan({ tasks: ["a", "b", "c"], arms: ["x", "y", "z"], repeats: 2 }))).toBe(true);
  });

  test("the old all-control-then-all-treatment order would not be balanced", () => {
    // What the previous harness did, expressed as a plan: every control cell
    // first. Both arms sit in position 0 of their own phase, so nothing cancels.
    const phased = [
      { task: "t1", repeat: 0, arm: "control", index: 0, positionInBlock: 0 },
      { task: "t2", repeat: 0, arm: "control", index: 1, positionInBlock: 0 },
      { task: "t1", repeat: 0, arm: "eden", index: 2, positionInBlock: 1 },
      { task: "t2", repeat: 0, arm: "eden", index: 3, positionInBlock: 1 },
    ];
    expect(positionBalance(phased).get("eden")).toEqual([0, 2]);
    expect(isBalanced(phased)).toBe(false);
  });

  test("rejects degenerate plans", () => {
    expect(() => runPlan({ tasks: ["t"], arms: ["only"] })).toThrow(/two arms/);
    expect(() => runPlan({ tasks: [], arms: ["a", "b"] })).toThrow(/one task/);
  });
});

describe("verdict", () => {
  test("pairs by task and repeat and drops unpaired blocks", () => {
    const t = [...samples("a", [10, 20]), { task: "b", repeat: 0, value: 5 }];
    const c = [...samples("a", [12, 25])];
    const paired = pairDeltas(t, c);
    expect(paired.map((p) => p.delta)).toEqual([-2, -5]);
  });

  test("calls a consistent improvement a WIN", () => {
    const control = grid({ t1: [1000, 1010, 990], t2: [2000, 2020, 1980] });
    const treatment = grid({ t1: [800, 810, 790], t2: [1600, 1620, 1580] });
    const d = decide({ treatment, control });
    expect(d.verdict).toBe("WIN");
    expect(d.delta.hi).toBeLessThan(0);
    expect(d.blocks).toBe(6);
  });

  test("calls a consistent regression a LOSS", () => {
    const control = grid({ t1: [1000, 1010, 990], t2: [2000, 2020, 1980] });
    const treatment = grid({ t1: [1200, 1210, 1190], t2: [2400, 2420, 2380] });
    expect(decide({ treatment, control }).verdict).toBe("LOSS");
  });

  test("refuses to call a difference smaller than the noise", () => {
    // Eden's real spread: the same cell varying by ±40% run to run. A harness
    // that reports the sign of the sum here is reporting a coin flip.
    const control = grid({ t1: [100_000, 60_000, 115_000], t2: [90_000, 130_000, 70_000] });
    const treatment = grid({ t1: [95_000, 110_000, 62_000], t2: [125_000, 71_000, 99_000] });
    const d = decide({ treatment, control });
    expect(d.verdict).toBe("INDISTINGUISHABLE");
    expect(d.delta.lo).toBeLessThan(0);
    expect(d.delta.hi).toBeGreaterThan(0);
    // And it says how big an effect it *could* have seen, so the null is readable.
    expect(d.mde).toBeGreaterThan(0);
    expect(d.reasons.join(" ")).toMatch(/includes zero/);
  });

  test("higherIsBetter flips which direction counts as a win", () => {
    const control = grid({ t1: [10, 10, 10], t2: [20, 20, 20] });
    const treatment = grid({ t1: [14, 15, 13], t2: [26, 25, 27] });
    expect(decide({ treatment, control, higherIsBetter: true }).verdict).toBe("WIN");
    expect(decide({ treatment, control, higherIsBetter: false }).verdict).toBe("LOSS");
  });

  test("declares the instrument invalid when A/A cells disagree", () => {
    // This is the finding that motivated the module: Eden's task-1 placebo cell
    // ran the *same* configuration on both arms and still showed a large,
    // one-sided gap. No A/B claim from such a session can be believed.
    const aaA = grid({ t1: [100, 102, 98], t2: [200, 205, 195] });
    const aaB = grid({ t1: [130, 133, 128], t2: [260, 266, 254] });
    const control = grid({ t1: [1000, 1010, 990], t2: [2000, 2020, 1980] });
    const treatment = grid({ t1: [500, 505, 495], t2: [1000, 1010, 990] });

    const d = decide({ treatment, control, nullControl: { a: aaA, b: aaB } });
    // The A/B signal here is enormous and perfectly consistent; it is still
    // not reportable, because the harness cannot measure straight.
    expect(d.verdict).toBe("UNTRUSTWORTHY_INSTRUMENT");
    expect(d.selfCheck?.passed).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/A\/A self-check failed/);
  });

  test("a clean A/A check lets the verdict through", () => {
    const aaA = grid({ t1: [100, 104, 97], t2: [200, 196, 203] });
    const aaB = grid({ t1: [101, 96, 103], t2: [198, 204, 199] });
    const control = grid({ t1: [1000, 1010, 990], t2: [2000, 2020, 1980] });
    const treatment = grid({ t1: [500, 505, 495], t2: [1000, 1010, 990] });
    const d = decide({ treatment, control, nullControl: { a: aaA, b: aaB } });
    expect(d.selfCheck?.passed).toBe(true);
    expect(d.verdict).toBe("WIN");
  });

  test("will not call a win from three tasks, however lopsided", () => {
    // Eden's benches run 3-4 tasks, one repeat. A paired sign test over 3 blocks
    // has 8 possible sign assignments, so its smallest two-sided p is 0.25 — the
    // design cannot reach alpha=0.05 no matter what the data says. This is the
    // shape of the real "45% faster" result: three blocks, all one direction.
    const control = grid({ t2: [200_000], t3: [300_000], t4: [250_000] });
    const treatment = grid({ t2: [100_000], t3: [115_000], t4: [120_000] });
    const d = decide({ treatment, control });
    expect(d.blocks).toBe(3);
    expect(d.verdict).toBe("INSUFFICIENT_DATA");
    expect(d.reasons.join(" ")).toMatch(/cannot return a p below 0\.250/);
    // Six blocks is the first n where 2/2^n drops under 0.05.
    expect(blocksForResolution(0.05)).toBe(6);
    expect(minAchievableP(3)).toBeCloseTo(0.25, 6);
    expect(minAchievableP(6)).toBeCloseTo(0.03125, 6);
  });

  test("the same effect measured over six blocks does resolve", () => {
    // Not a stricter standard for its own sake: doubling the blocks is all it
    // takes for the identical effect to become reportable.
    const control = grid({ t2: [200_000, 205_000], t3: [300_000, 295_000], t4: [250_000, 255_000] });
    const treatment = grid({ t2: [100_000, 104_000], t3: [115_000, 118_000], t4: [120_000, 122_000] });
    const d = decide({ treatment, control });
    expect(d.blocks).toBe(6);
    expect(d.verdict).toBe("WIN");
    expect(d.p).toBeLessThanOrEqual(0.05);
  });

  test("a CI clear of zero is not enough on its own", () => {
    // The bootstrap resamples from the observed points, so its tails can never
    // reach past them; with few, same-signed blocks it happily excludes zero
    // while the permutation test still cannot rule out chance. Requiring both
    // gates is what stops that from reading as a win.
    const control = grid({ t2: [1000], t3: [1000], t4: [1000], t5: [1000], t6: [1000], t7: [1000] });
    const treatment = grid({ t2: [995], t3: [996], t4: [994], t5: [1400], t6: [300], t7: [1500] });
    const d = decide({ treatment, control });
    expect(d.verdict).toBe("INDISTINGUISHABLE");
    expect(d.reasons.join(" ")).toMatch(/Smallest detectable effect/);
  });

  test("a noisy A/A check reports underpowered, not passed", () => {
    // Eden's real A/A cells: 5 blocks with a 29-point spread. They contain no
    // detectable bias, but they are nowhere near sensitive enough to show that
    // the harness is unbiased. Calling that "passed" would launder a shrug into
    // a clean bill of health.
    const aaA = grid({ t1: [100_000], t2: [60_000], t3: [115_000], t4: [90_000], t5: [130_000] });
    const aaB = grid({ t1: [71_000], t2: [99_000], t3: [95_000], t4: [110_000], t5: [62_000] });
    const control = grid({ x1: [1000, 1010, 990], x2: [2000, 2020, 1980] });
    const treatment = grid({ x1: [500, 505, 495], x2: [1000, 1010, 990] });
    const d = decide({ treatment, control, nullControl: { a: aaA, b: aaB } });
    expect(d.selfCheck?.status).toBe("underpowered");
    expect(d.selfCheck?.passed).toBe(false);
    expect(d.selfCheck?.relativeMde).toBeGreaterThan(0.1);
    expect(d.reasons.join(" ")).toMatch(/underpowered/);
    // Underpowered is a caveat, not a veto: only a *detected* bias invalidates.
    expect(d.verdict).toBe("WIN");
  });

  test("reports INSUFFICIENT_DATA rather than guessing from one block", () => {
    const d = decide({
      treatment: [{ task: "t1", repeat: 0, value: 500 }],
      control: [{ task: "t1", repeat: 0, value: 1000 }],
    });
    expect(d.verdict).toBe("INSUFFICIENT_DATA");
    expect(d.blocks).toBe(1);
  });
});

describe("score", () => {
  const spec = [
    { name: "number", required: true },
    { name: "title", required: true },
    { name: "reviews", required: true },
    { name: "status", required: true },
    { name: "files", required: true },
  ];

  test("a partial answer scores partially", () => {
    // The product bench's compiled tool returned exactly these three fields
    // while advertising five, and the old scorer gave it full marks.
    const gold = { number: 166, title: "feat(help): find the file", reviews: 1, status: "failure", files: 3 };
    const answer = { number: 166, title: "feat(help): find the file", reviews: 1 };
    const r = scoreRecord(answer, gold, spec);
    expect(r.score).toBe(3);
    expect(r.max).toBe(5);
    expect(r.missing).toEqual(["status", "files"]);
    expect(r.fabricated).toEqual([]);
  });

  test("fabrication scores below omission", () => {
    const gold = { number: 166, title: "feat(help): find the file", reviews: 1, status: "failure", files: 3 };
    // The exact fabrication captured in bench-compile-results.json.
    const fabricating = { number: 166, title: "Fix deploy for 166", reviews: 6, status: "pending", files: 9 };
    const omitting = { number: 166 };
    const fab = scoreRecord(fabricating, gold, spec);
    const omit = scoreRecord(omitting, gold, spec);

    expect(fab.fabricated).toEqual(["title", "reviews", "status", "files"]);
    expect(fab.score).toBeLessThan(omit.score);
    // A confident wrong answer must never read as a tie with the truth.
    expect(fab.score).toBeLessThan(scoreRecord(gold, gold, spec).score);
  });

  test("a perfect answer scores full marks", () => {
    const gold = { number: 166, title: "t", reviews: 1, status: "failure", files: 3 };
    const r = scoreRecord({ ...gold }, gold, spec);
    expect(r.score).toBe(5);
    expect(r.max).toBe(5);
    expect(r.fabricated).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  test("looseEquals forgives formatting but not facts", () => {
    expect(looseEquals("166", 166)).toBe(true);
    expect(looseEquals(" Failure ", "failure")).toBe(true);
    expect(looseEquals("failure", "pending")).toBe(false);
    expect(looseEquals(null, "x")).toBe(false);
  });

  test("dropping rows cannot raise the suite score", () => {
    const gold = [
      { id: 1, status: "ok" },
      { id: 2, status: "fail" },
      { id: 3, status: "ok" },
    ];
    const fieldSpec = [{ name: "status", required: true }];
    const all = scoreRecords(gold, gold, fieldSpec);
    const partial = scoreRecords([{ id: 1, status: "ok" }], gold, fieldSpec);
    expect(all.fraction).toBe(1);
    expect(partial.fraction).toBeCloseTo(1 / 3, 6);
    expect(partial.missingRecords).toBe(2);
  });

  test("a fabricating suite reports 0%, never a tie", () => {
    const gold = [{ id: 1, status: "failure" }, { id: 2, status: "success" }];
    const lies = [{ id: 1, status: "success" }, { id: 2, status: "failure" }];
    const s = scoreRecords(lies, gold, [{ name: "status", required: true }]);
    expect(s.fabricated).toBe(true);
    expect(s.fabricatedFields).toBe(2);
    expect(s.fraction).toBe(0);
  });
});

describe("the scorer does not award marks it cannot justify", () => {
  test("two different objects are not equal", () => {
    // `String({...})` is "[object Object]" for every plain object, so the
    // normalising comparison rated any two objects equal. A record whose
    // nested field was completely wrong scored full marks with zero
    // fabrications — the exact saturation this module exists to prevent.
    expect(looseEquals({ login: "alice" }, { login: "bob" })).toBe(false);
    expect(looseEquals({ login: "alice" }, { login: "alice" })).toBe(true);
    expect(looseEquals([1, 2], [1, 3])).toBe(false);
    expect(looseEquals([1, 2], [1, 2])).toBe(true);
    expect(looseEquals({ a: 1 }, [1])).toBe(false);
    expect(looseEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true); // key order is not a difference
  });

  test("a wrong nested field is scored wrong, not correct", () => {
    const r = scoreRecord(
      { owner: { login: "WRONG" }, n: 5 },
      { owner: { login: "alice" }, n: 5 },
      [{ name: "owner" }, { name: "n" }],
    );
    expect(r.score).toBe(0); // one correct, one fabricated, penalty 1
    expect(r.max).toBe(2);
    expect(r.fabricated).toEqual(["owner"]);
  });

  test("a boolean is not loosely equal to a number or an empty string", () => {
    expect(looseEquals(1, true)).toBe(false);
    expect(looseEquals(0, false)).toBe(false);
    expect(looseEquals(0, "")).toBe(false);
    expect(looseEquals(true, true)).toBe(true);
  });

  test("correctly reporting a null gold value earns the point", () => {
    // `present` also required the value to be non-null, so an answer that
    // correctly said null was recorded as having omitted the field. Fields
    // whose gold value is legitimately null — merged_at, closed_by, assignee
    // — were unscoreable.
    const r = scoreRecord({ merged_at: null }, { merged_at: null }, [{ name: "merged_at" }]);
    expect(r.missing).toEqual([]);
    expect(r.score).toBe(1);
  });

  test("claiming a value where gold says null is still wrong", () => {
    const r = scoreRecord({ merged_at: "2024-01-01" }, { merged_at: null }, [{ name: "merged_at" }]);
    expect(r.fabricated).toEqual(["merged_at"]);
  });
});

describe("sizing an experiment uses the right distribution", () => {
  test("tQuantile matches published tables", () => {
    // These two functions sized experiments with the *normal* quantile, but
    // decide() requires only 6 blocks — so the normal approximation was used
    // exactly where it is worst. At 5 degrees of freedom t(0.975) is 2.571
    // against z's 1.960: the minimum detectable effect was understated by
    // about 24% and the required sample size under-quoted by about 55%.
    const known: Array<[number, number, number]> = [
      [0.975, 4, 2.7764],
      [0.975, 5, 2.5706],
      [0.975, 10, 2.2281],
      [0.975, 30, 2.0423],
      [0.95, 5, 2.015],
      [0.8, 5, 0.9195],
      [0.8, 10, 0.8791],
    ];
    for (const [p, df, want] of known) {
      expect(Math.abs(tQuantile(p, df) - want)).toBeLessThan(0.005);
    }
  });

  test("one and two degrees of freedom use their closed forms", () => {
    // The Cornish–Fisher expansion is asymptotic in 1/df and diverges here,
    // where the true quantiles are enormous.
    expect(Math.abs(tQuantile(0.975, 1) - 12.7062)).toBeLessThan(0.01);
    expect(Math.abs(tQuantile(0.975, 2) - 4.3027)).toBeLessThan(0.01);
  });

  test("it converges on the normal as the sample grows", () => {
    expect(Math.abs(tQuantile(0.975, 1000) - 1.95996)).toBeLessThan(0.005);
  });

  test("minDetectableEffect and requiredBlocks are inverses", () => {
    for (const n of [4, 8, 16, 64]) {
      expect(requiredBlocks(100, minDetectableEffect(100, n))).toBe(n);
    }
  });

  test("a t-based bound is stricter than the normal one it replaced", () => {
    // The point of the change: at small n the honest number is bigger.
    const df = 5;
    expect(minDetectableEffect(100, df + 1)).toBeGreaterThan((1.95996 + 0.8416) * (100 / Math.sqrt(df + 1)));
  });
});

describe("a block pairs one control with one treatment", () => {
  test("duplicate blocks are refused, not silently multiplied", () => {
    // byKey was last-write-wins and was never consumed, so N treatment rows
    // sharing a key all paired against the same control value — turning one
    // real block into N "independent" ones, which inflates n and shrinks both
    // the bootstrap interval and the permutation p-value. A module that
    // exists to refuse over-claiming must not manufacture its own sample size.
    const control = [{ task: "a", repeat: 0, value: 1 }];
    const treatment = [
      { task: "a", repeat: 0, value: 2 },
      { task: "a", repeat: 0, value: 3 },
    ];
    expect(() => pairDeltas(treatment, control)).toThrow(/one to one/);
    expect(() => pairDeltas(control, [...control, ...control])).toThrow(/one to one/);
  });

  test("ordinary paired samples are unaffected", () => {
    const control = [
      { task: "a", repeat: 0, value: 1 },
      { task: "b", repeat: 0, value: 2 },
    ];
    const treatment = [
      { task: "a", repeat: 0, value: 3 },
      { task: "b", repeat: 0, value: 5 },
    ];
    expect(pairDeltas(treatment, control).map((d) => d.delta)).toEqual([2, 3]);
  });
});
