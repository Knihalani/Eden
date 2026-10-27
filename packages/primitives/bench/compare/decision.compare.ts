/**
 * The decision primitives (stats.ts, random.ts, calibrate.ts, bandit.ts, pack.ts) against the npm libraries that
 * could have replaced them: accuracy against scipy/scikit-learn reference values and speed on Eden-shaped inputs.
 * None of these libraries is a repo dependency. Install them in a scratch directory and link its node_modules next to
 * this file for the run (do not commit the link):
 *
 *   cd /tmp/x && bun add jstat@1.9.6 @stdlib/random-base-beta@0.2.2 @stdlib/stats-base-dists-beta-quantile@0.2.3 \
 *     ml-logistic-regression@2.0.0 ml-matrix@6.15.1 pure-rand@8.4.2 seedrandom@3.0.5 simple-statistics@7.12.1 \
 *     @langchain/core@1.3.0
 *   ln -s /tmp/x/node_modules packages/primitives/bench/compare/node_modules
 *   bun packages/primitives/bench/compare/decision.compare.ts
 */
import { maximalMarginalRelevance } from "@langchain/core/utils/math";
import stdlibBeta from "@stdlib/random-base-beta";
import stdlibBetaQuantile from "@stdlib/stats-base-dists-beta-quantile";
import jStatModule from "jstat";
import LogisticRegression from "ml-logistic-regression";
import { Matrix } from "ml-matrix";
import { xoroshiro128plus } from "pure-rand/generator/xoroshiro128plus";
import seedrandom from "seedrandom";
import { binomialDistribution } from "simple-statistics";
import { Logistic } from "../../src/calibrate";
import { Packer } from "../../src/pack";
import { Xoshiro128 } from "../../src/random";
import { betaInc, binomCdf, clopperPearsonLower, clopperPearsonUpper } from "../../src/stats";
import { bench, consume, report } from "../harness";

const jStat = (jStatModule as unknown as { jStat?: unknown }).jStat ?? jStatModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const J = jStat as any;

const rel = (a: number, b: number) => (b === 0 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b));
const sci = (x: number) => (Number.isFinite(x) ? x.toExponential(1) : String(x));

// ── 1. Clopper–Pearson bounds and the binomial CDF (scipy 1.18.1 values, as in stats.test.ts) ──
const CP_UPPER: [number, number, number, number][] = [
  [0, 22, 0.1, 0.09937197978872149],
  [0, 10, 0.05, 0.2588655508930522],
  [3, 50, 0.1, 0.1287564225866019],
  [12, 200, 0.1, 0.08761788029993338],
  [19, 200, 0.05, 0.13627776482107667],
  [99, 100, 0.1, 0.9989469496904544],
  [500, 1000, 1e-6, 0.5752094927452731],
];
const CP_LOWER: [number, number, number, number][] = [
  [1, 22, 0.1, 0.004777664824947516],
  [5, 10, 0.05, 0.2224411010081294],
  [188, 200, 0.1, 0.9123821197000667],
];
const BINOM: [number, number, number, number][] = [
  [0, 22, 0.1, 0.0984770902183611],
  [3, 50, 0.1, 0.250293905953308],
  [12, 200, 0.1, 0.0320465287969066],
  [0, 1000, 0.001, 0.36769542477096406],
  [950, 1000, 0.97, 0.0004207665452482011],
];
function worst(fn: (k: number, n: number, x: number) => number, rows: [number, number, number, number][]) {
  let w = 0;
  for (const [k, n, x, v] of rows) {
    const got = fn(k, n, x);
    w = Math.max(w, Number.isFinite(got) ? rel(got, v) : Infinity);
  }
  return w;
}
const cpOwn = (k: number, n: number, d: number) => clopperPearsonUpper(k, n, d);
const cpJstat = (k: number, n: number, d: number) => J.beta.inv(1 - d, k + 1, n - k);
const cpStdlib = (k: number, n: number, d: number) => stdlibBetaQuantile(1 - d, k + 1, n - k);
const cpLoOwn = (k: number, n: number, d: number) => clopperPearsonLower(k, n, d);
const cpLoJstat = (k: number, n: number, d: number) => J.beta.inv(d, k, n - k + 1);
const cpLoStdlib = (k: number, n: number, d: number) => stdlibBetaQuantile(d, k, n - k + 1);
const ssBinomCdf = (k: number, n: number, p: number) => {
  const pmf = binomialDistribution(n, p) as number[] | undefined;
  if (!pmf) return NaN;
  let s = 0;
  for (let i = 0; i <= k && i < pmf.length; i++) s += pmf[i]!;
  return s;
};
console.log("── Clopper–Pearson bounds, binomial CDF: worst relative error vs scipy");
console.log(
  `  upper bound   own ${sci(worst(cpOwn, CP_UPPER))}  jstat ${sci(worst(cpJstat, CP_UPPER))}  @stdlib ${sci(worst(cpStdlib, CP_UPPER))}`,
);
console.log(
  `  lower bound   own ${sci(worst(cpLoOwn, CP_LOWER))}  jstat ${sci(worst(cpLoJstat, CP_LOWER))}  @stdlib ${sci(worst(cpLoStdlib, CP_LOWER))}`,
);
console.log(
  `  binomial cdf  own ${sci(worst(binomCdf, BINOM))}  jstat ${sci(worst((k, n, p) => J.binomial.cdf(k, n, p), BINOM))}  simple-statistics ${sci(worst(ssBinomCdf, BINOM))}`,
);
report([
  bench("CP upper (12 of 200, δ 0.1): own", () => clopperPearsonUpper(12, 200, 0.1)),
  bench("CP upper (12 of 200, δ 0.1): jstat beta.inv", () => cpJstat(12, 200, 0.1)),
  bench("CP upper (12 of 200, δ 0.1): @stdlib quantile", () => cpStdlib(12, 200, 0.1)),
  bench("binomial cdf (12, 200, 0.1): own", () => binomCdf(12, 200, 0.1)),
  bench("binomial cdf (12, 200, 0.1): jstat", () => J.binomial.cdf(12, 200, 0.1)),
  bench("binomial cdf (12, 200, 0.1): simple-statistics", () => ssBinomCdf(12, 200, 0.1), { batch: 20 }),
]);

// ── 2. Logistic regression: 12 rows, 2 features, unpenalized MLE (scikit-learn 1.9.1, penalty=None) ──
const X = [
  [0.1, 1.2],
  [0.4, 0.3],
  [0.5, 1.9],
  [0.9, 0.2],
  [1.1, 1.4],
  [1.3, 0.8],
  [1.8, 1.1],
  [2.0, 0.1],
  [2.2, 1.7],
  [2.6, 0.9],
  [3.0, 1.3],
  [3.1, 0.4],
];
const Y = [0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1];
const MLE = [4.593032025821637, -4.360120261089523, -2.1057141163214723];
const own = new Logistic(2);
const xFlat = Float64Array.from(X.flat());
const yFlat = Float64Array.from(Y);
own.fit(xFlat, yFlat, 12, 0, 100);
const ml = new LogisticRegression({ numSteps: 50_000, learningRate: 5e-4 });
const xBias = new Matrix(X.map((r) => [...r, 1])); // ml-logistic-regression has no intercept: add a column
ml.train(xBias, Matrix.columnVector(Y));
// One-vs-all: classifier 1 models "not class 1" for its labels; its weights are the negation of P(y = 1)'s.
const mlW = (ml.classifiers[1].weights as Matrix).to1DArray().map((w: number) => -w);
console.log("── Logistic regression, unpenalized, vs scikit-learn coefficients");
console.log(`  own Newton:             max rel err ${sci(Math.max(...MLE.map((v, i) => rel(own.weights[i]!, v))))}`);
console.log(`  ml-logistic-regression: max rel err ${sci(Math.max(...MLE.map((v, i) => rel(mlW[i]!, v))))}`);
report([
  bench("fit 12×2: own Newton", () => own.fit(xFlat, yFlat, 12, 0, 100), { batch: 20 }),
  bench(
    "fit 12×2: ml-logistic-regression (50k GD steps)",
    () => {
      const m = new LogisticRegression({ numSteps: 50_000, learningRate: 5e-4 });
      m.train(xBias, Matrix.columnVector(Y));
      return m;
    },
    { batch: 1, batches: 5 },
  ),
]);

// ── 3. Seedable uniform generators ──
const xo = new Xoshiro128(1);
let a0 = 0x9e3779b9 | 0;
let a1 = 0x243f6a88 | 0;
let a2 = 0xb7e15162 | 0;
let a3 = 1;
/** sfc32 (Chris Doty-Humphrey's Small Fast Counting generator), the usual alternative in JS. */
const sfc32 = () => {
  const t = (((a0 + a1) | 0) + a3) | 0;
  a3 = (a3 + 1) | 0;
  a0 = a1 ^ (a1 >>> 9);
  a1 = (a2 + (a2 << 3)) | 0;
  a2 = (a2 << 21) | (a2 >>> 11);
  a2 = (a2 + t) | 0;
  return (t >>> 0) / 4294967296;
};
const pr = xoroshiro128plus(1);
const alea = seedrandom.alea("1");
const xor4096 = seedrandom.xor4096("1");
console.log("── Seedable uniform generators (one double each)");
report([
  bench("own xoshiro128** uniform()", () => xo.uniform(), { batch: 2000 }),
  bench("sfc32 (inline)", () => sfc32(), { batch: 2000 }),
  bench("pure-rand xoroshiro128+ next() / 2^32", () => (pr.next() >>> 0) / 4294967296, { batch: 2000 }),
  bench("seedrandom alea", () => alea(), { batch: 2000 }),
  bench("seedrandom xor4096", () => xor4096(), { batch: 2000 }),
  bench("Math.random (not seedable)", () => Math.random(), { batch: 2000 }),
]);

// ── 4. Beta sampling: speed and a Kolmogorov–Smirnov check against the exact CDF ──
const stdlibRand = stdlibBeta.factory({ seed: 1234 });
const seeded = new Xoshiro128(77);
J.setRandom(() => seeded.uniform()); // jstat draws from Math.random by default; seed it for the KS check
function ks(sample: (a: number, b: number) => number, a: number, b: number): number {
  const n = 20_000;
  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = sample(a, b);
  xs.sort();
  let d = 0;
  for (let i = 0; i < n; i++) {
    const f = betaInc(xs[i]!, a, b);
    if (!(f >= 0)) return NaN;
    d = Math.max(d, Math.abs(f - i / n), Math.abs((i + 1) / n - f));
  }
  return d;
}
const ownBeta = new Xoshiro128(5);
const samplers: [string, (a: number, b: number) => number][] = [
  ["own (Marsaglia–Tsang)", (a, b) => ownBeta.beta(a, b)],
  ["@stdlib/random-base-beta", (a, b) => stdlibRand(a, b)],
  ["jstat beta.sample", (a, b) => J.beta.sample(a, b)],
];
console.log("── Beta sampling: KS statistic, n = 20,000 (0.1% critical value 0.0138)");
for (const [name, f] of samplers) {
  const shapes: [number, number][] = [
    [0.4, 3.6],
    [2.5, 7.5],
    [0.05, 2],
    [1000, 2000],
  ];
  console.log(`  ${name.padEnd(26)} ${shapes.map(([a, b]) => `Beta(${a},${b}) ${ks(f, a, b).toFixed(4)}`).join("  ")}`);
}
const shapesA = Float64Array.from({ length: 30 }, (_, i) => 0.4 + i * 0.7);
const shapesB = Float64Array.from({ length: 30 }, (_, i) => 3.6 + i * 1.3);
report(
  samplers.map(([name, f]) =>
    bench(`30 Beta draws (shapes 0.4–21, 3.6–41): ${name}`, () => {
      let s = 0;
      for (let i = 0; i < 30; i++) s += f(shapesA[i]!, shapesB[i]!);
      return s;
    }),
  ),
);

// ── 5. MMR: LangChain's maximalMarginalRelevance (embeddings in, cosine inside, no costs or budget) ──
const dim = 64;
const n = 50;
const embRng = new Xoshiro128(9);
const emb: number[][] = Array.from({ length: n }, () => Array.from({ length: dim }, () => embRng.normal()));
const query: number[] = Array.from({ length: dim }, () => embRng.normal());
const relv = new Float64Array(n);
const simM = new Float64Array(n * n);
const cost = new Float64Array(n).fill(200);
const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
for (let i = 0; i < n; i++) {
  relv[i] = Math.max(0, emb[i]!.reduce((s, x, j) => s + x * query[j]!, 0) / (norm(emb[i]!) * norm(query)));
  for (let j = 0; j < n; j++) {
    simM[i * n + j] = Math.max(
      0,
      emb[i]!.reduce((s, x, k) => s + x * emb[j]![k]!, 0) / (norm(emb[i]!) * norm(emb[j]!)),
    );
  }
}
const packer = new Packer(n);
const outIds = new Int32Array(3);
console.log("── MMR over 50 candidates, k = 3 (LangChain computes cosine itself; Packer takes precomputed sims)");
report([
  bench("@langchain/core maximalMarginalRelevance (64-d)", () => maximalMarginalRelevance(query, emb, 0.7, 3), {
    batch: 20,
  }),
  bench("own Packer.pack (precomputed 50×50 sims)", () => packer.pack(relv, cost, simM, n, 1200, 3, 1, 0.5, outIds)),
]);
consume(outIds);
