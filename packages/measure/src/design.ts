/**
 * Run ordering.
 *
 * Eden's benches ran every control session first, then every treatment session
 * (`for (task) without` then `for (task) with`). Against a live API that is not
 * a neutral choice: rate-limit state, cache warmth and time-of-day all drift
 * across the run and land entirely on whichever arm went last. The A/A cells
 * measured that drift at a mean of +26% against the second arm — larger than
 * any effect the benchmark was trying to detect.
 *
 * Two changes fix it, and neither costs a single extra session:
 *
 *   - interleave, so a block's two arms run back to back and share their
 *     environment as closely as possible;
 *   - counterbalance, so each arm goes first in half the blocks and any
 *     remaining order effect cancels in the mean instead of accumulating.
 */

export type Cell = {
  task: string;
  repeat: number;
  arm: string;
  /** Execution order across the whole plan. */
  index: number;
  /** Position of this arm within its block, starting at 0. */
  positionInBlock: number;
};

export type PlanOpts = {
  tasks: readonly string[];
  /** Two for a normal A/B. Pass the same arm twice to build an A/A self-check. */
  arms: readonly string[];
  repeats?: number;
  /** Rotates which arm leads. Same seed, same plan. */
  seed?: number;
};

/**
 * A counterbalanced, interleaved execution plan.
 *
 * Arm order rotates deterministically by block, so with two arms and an even
 * number of blocks each arm leads exactly half of them.
 */
export function runPlan(opts: PlanOpts): Cell[] {
  const repeats = opts.repeats ?? 1;
  const arms = [...opts.arms];
  if (arms.length < 2) throw new Error("runPlan needs at least two arms");
  if (!opts.tasks.length) throw new Error("runPlan needs at least one task");
  const seed = opts.seed ?? 0;
  const cells: Cell[] = [];
  let index = 0;
  let block = 0;
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const task of opts.tasks) {
      const shift = (block + seed) % arms.length;
      const ordered = [...arms.slice(shift), ...arms.slice(0, shift)];
      ordered.forEach((arm, positionInBlock) => {
        cells.push({ task, repeat, arm, index: index++, positionInBlock });
      });
      block++;
    }
  }
  return cells;
}

/**
 * How often each arm ran in each within-block position.
 *
 * A plan is balanced when every arm appears in every position the same number
 * of times; that is the property that makes order effects cancel. Worth
 * asserting in a test, because it is easy to break and invisible when broken.
 */
export function positionBalance(cells: readonly Cell[]): Map<string, number[]> {
  const arms = [...new Set(cells.map((c) => c.arm))];
  const width = Math.max(...cells.map((c) => c.positionInBlock)) + 1;
  const out = new Map<string, number[]>();
  for (const arm of arms) out.set(arm, new Array(width).fill(0));
  for (const c of cells) out.get(c.arm)![c.positionInBlock]! += 1;
  return out;
}

export function isBalanced(cells: readonly Cell[]): boolean {
  for (const counts of positionBalance(cells).values()) {
    if (Math.max(...counts) - Math.min(...counts) > 1) return false;
  }
  return true;
}
