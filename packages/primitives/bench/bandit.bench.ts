/**
 * Source selection: cost per decision, then what the choice is worth: cumulative regret and how well each policy's
 * usefulness estimates track the truth, on simulated sources whose usefulness is stationary, shifts abruptly, or
 * drifts. Parameters (γ, prior strength 4, ε) are the research notes' starting points, not tuned here: the table
 * reports several so the sensitivity is visible.
 *
 * Environments (N sources, k = 3 queried per decision, T = 5,000 decisions, 20 seeds each):
 * - stationary: p_i ~ Beta(1, 3) (mean 0.25), fixed;
 * - abrupt: every 1,000 decisions each source redraws its p_i with probability 0.3;
 * - drift: logit p_i takes a Gaussian random-walk step of sd 0.05 per decision.
 * Reward per queried source: Bernoulli(p_i). Regret per decision: Σ of the k best p_i minus Σ p_i of those queried.
 */
import { BetaBandit } from "../src/bandit";
import { Xoshiro128 } from "../src/random";
import { bench, report } from "./harness";

// ── Cost per decision ──
{
  const rng = new Xoshiro128(1);
  const out = new Int32Array(3);
  const pi = new Float64Array(30);
  const eligible = new Uint8Array(30).fill(1);
  eligible[3] = 0;
  const b30 = new BetaBandit(30, new Float64Array(30).fill(0.25), 4, 0.99, 3);
  const b12 = new BetaBandit(12, new Float64Array(12).fill(0.25), 4, 0.99, 3);
  for (let i = 0; i < 30; i++) for (let j = 0; j < i; j++) b30.update(i, j % 3 === 0 ? 1 : 0);
  report([
    bench("select k=3 of 30 arms (TS, ε 0.05)", () => b30.select(rng, 3, null, null, 0.05, out)),
    bench("select k=3 of 30 arms, eligibility mask", () => b30.select(rng, 3, eligible, null, 0.05, out)),
    bench("select k=3 of 12 arms (TS, ε 0.05)", () => b12.select(rng, 3, null, null, 0.05, out)),
    bench("update 3 arms + decay(1), 30 arms", () => {
      b30.update(1, 1);
      b30.update(2, 0);
      b30.update(3, 0);
      b30.decay(1);
    }),
    bench("inclusionPropensity, 30 arms, 200 draws", () => b30.inclusionPropensity(rng, 3, null, null, 0.05, 200, pi), {
      batch: 10,
    }),
  ]);
}

// ── Regret simulation ──
type Env = "stationary" | "abrupt" | "drift";
interface Policy {
  name: string;
  /** 0: Thompson sampling; 1: greedy by posterior mean; 2: uniform. */
  kind: number;
  /** Discount only the updated arm's own history (`decayArm`) instead of every arm per decision (`decay`). */
  perArm: boolean;
  priorMean: number;
  priorStrength: number;
  gamma: number;
  epsilon: number;
}
const POLICIES: Policy[] = [
  { name: "uniform random", kind: 2, perArm: false, priorMean: 0.5, priorStrength: 2, gamma: 1, epsilon: 0 },
  {
    name: "greedy mean, Beta(1,1) (today's ranking)",
    kind: 1,
    perArm: false,
    priorMean: 0.5,
    priorStrength: 2,
    gamma: 1,
    epsilon: 0,
  },
  { name: "TS, Beta(1,1), γ 1", kind: 0, perArm: false, priorMean: 0.5, priorStrength: 2, gamma: 1, epsilon: 0 },
  { name: "TS, prior 0.25×4, γ 1", kind: 0, perArm: false, priorMean: 0.25, priorStrength: 4, gamma: 1, epsilon: 0 },
  ...[0.995, 0.99, 0.98].map((gamma) => ({
    name: `TS, prior 0.25×4, γ ${gamma}`,
    kind: 0,
    perArm: false,
    priorMean: 0.25,
    priorStrength: 4,
    gamma,
    epsilon: 0,
  })),
  ...[0.99, 0.98].map((gamma) => ({
    name: `TS, prior 0.25×4, γ ${gamma} per arm`,
    kind: 0,
    perArm: true,
    priorMean: 0.25,
    priorStrength: 4,
    gamma,
    epsilon: 0,
  })),
  {
    name: "TS, prior 0.25×4, γ 0.99, ε 0.05",
    kind: 0,
    perArm: false,
    priorMean: 0.25,
    priorStrength: 4,
    gamma: 0.99,
    epsilon: 0.05,
  },
];

const logit = (p: number) => Math.log(p / (1 - p));
const expit = (z: number) => 1 / (1 + Math.exp(-z));

/** Mean regret per decision, the same over the first 200 decisions, and the mean |posterior mean − p|. */
function run(env: Env, arms: number, policy: Policy, seed: number): [number, number, number] {
  const k = 3;
  const T = 5000;
  const world = new Xoshiro128(seed); // the environment's stream: identical across policies for a seed
  const rng = new Xoshiro128(seed * 7919 + 1);
  const p = new Float64Array(arms);
  const z = new Float64Array(arms);
  for (let i = 0; i < arms; i++) {
    p[i] = world.beta(1, 3);
    z[i] = logit(Math.min(0.999, Math.max(0.001, p[i]!)));
  }
  const b = new BetaBandit(arms, new Float64Array(arms).fill(policy.priorMean), policy.priorStrength, policy.gamma, k);
  const out = new Int32Array(k);
  const sorted = new Float64Array(arms);
  const order = new Int32Array(arms);
  const coin = new Float64Array(arms);
  let regret = 0;
  let early = 0;
  let track = 0;
  let trackN = 0;
  for (let t = 0; t < T; t++) {
    if (env === "abrupt" && t > 0 && t % 1000 === 0) {
      for (let i = 0; i < arms; i++) if (world.uniform() < 0.3) p[i] = world.beta(1, 3);
    } else if (env === "drift") {
      for (let i = 0; i < arms; i++) {
        z[i]! += 0.05 * world.normal();
        p[i] = expit(z[i]!);
      }
    }
    // Every source's reward coin is drawn whether or not it is queried, so policies see the same world.
    for (let i = 0; i < arms; i++) coin[i] = world.uniform();
    let got: number;
    if (policy.kind === 2) got = b.select(rng, k, null, null, 1, out);
    else if (policy.kind === 1) {
      for (let i = 0; i < arms; i++) order[i] = i;
      order.sort((x, y) => b.mean(y) - b.mean(x) || x - y);
      for (let j = 0; j < k; j++) out[j] = order[j]!;
      got = k;
    } else got = b.select(rng, k, null, null, policy.epsilon, out);
    sorted.set(p);
    sorted.sort();
    let best = 0;
    for (let j = 0; j < k; j++) best += sorted[arms - 1 - j]!;
    let have = 0;
    for (let j = 0; j < got; j++) {
      const a = out[j]!;
      have += p[a]!;
      if (policy.perArm) b.decayArm(a, 1);
      b.update(a, coin[a]! < p[a]! ? 1 : 0);
    }
    if (!policy.perArm) b.decay(1);
    regret += best - have;
    if (t < 200) early += best - have;
    if (t % 50 === 49) {
      for (let i = 0; i < arms; i++) track += Math.abs(b.mean(i) - p[i]!);
      trackN += arms;
    }
  }
  return [regret / T, early / 200, track / trackN];
}

const SEEDS = 20;
for (const arms of [12, 30]) {
  for (const env of ["stationary", "abrupt", "drift"] as Env[]) {
    console.log(
      `── ${env}, ${arms} sources, k = 3, T = 5000, ${SEEDS} seeds: regret/decision (sd), first 200, |mean − p|`,
    );
    for (const policy of POLICIES) {
      const r: number[] = [];
      let early = 0;
      let track = 0;
      for (let s = 1; s <= SEEDS; s++) {
        const [a, e, tr] = run(env, arms, policy, s);
        r.push(a);
        early += e / SEEDS;
        track += tr / SEEDS;
      }
      const mean = r.reduce((x, y) => x + y, 0) / SEEDS;
      const sd = Math.sqrt(r.reduce((x, y) => x + (y - mean) ** 2, 0) / (SEEDS - 1));
      console.log(
        `  ${policy.name.padEnd(44)} ${mean.toFixed(4)} (${sd.toFixed(4)})   ${early.toFixed(4)}   ${track.toFixed(4)}`,
      );
    }
  }
}
