import { TopK } from "../src/topk";
import { bench, report } from "./harness";

const scores = Float64Array.from({ length: 10_000 }, (_, i) => Math.sin(i) * 1000);
const topk = new TopK(10);
const ids = new Int32Array(10);
report([
  bench(
    "TopK(10): push per candidate, 10k",
    () => {
      for (let i = 0; i < scores.length; i++) topk.push(i, scores[i]!);
      return topk.drain(ids, null);
    },
    { batch: 5 },
  ),
  bench(
    "TopK(10): pushDense, 10k",
    () => {
      topk.pushDense(scores, 0, scores.length, -Infinity);
      return topk.drain(ids, null);
    },
    { batch: 5 },
  ),
  bench(
    "Array sort + slice(10), 10k",
    () =>
      Array.from(scores.keys())
        .sort((a, b) => scores[b]! - scores[a]!)
        .slice(0, 10),
    { batch: 2 },
  ),
]);
