import type { Binding, IslandCaller, Step, StretchProgram, ToolRegistry } from "@eden/ir";
import { asArray, assertValid, inDistribution, isBarrierName, isReadName } from "@eden/ir";
import { ChildScope, evalArgs, evalBinding, type BindScope } from "./bind";

import { DeoptError } from "./deopt";
import { evalAssert } from "./assert";

/**
 * Fan-out width for a provably read-only loop body. Bounded because the point
 * is to stop paying N round trips in series, not to open N sockets at once
 * against someone's rate limit.
 */
export const DEFAULT_LOOP_CONCURRENCY = 8;

export type RunStats = {
  llmCalls: number;
  toolCalls: string[];
  ms: number;
  cents: number;
  deopt: boolean;
  deoptReason?: string;
  skipped: string[];
};

export type RunResult = {
  value: unknown;
  stats: RunStats;
};

export type RunOpts = {
  registry: ToolRegistry;
  island?: IslandCaller;
  llmCents?: number;
  checkEnvelope?: boolean;
  timeoutMs?: number;
  /**
   * Maximum iterations in flight for a loop whose body is provably read-only.
   * 1 restores fully sequential execution. Defaults to DEFAULT_LOOP_CONCURRENCY.
   */
  loopConcurrency?: number;
};

function bindingDeps(b: Binding): string[] {
  if (b.kind === "from") return [b.step];
  if (b.kind === "transform") return bindingDeps(b.of);
  return [];
}

function stepDeps(step: Step): string[] {
  if (step.kind === "tool") return Object.values(step.args).flatMap(bindingDeps);
  if (step.kind === "island") return bindingDeps(step.input);
  if (step.kind === "loop") return bindingDeps(step.over);
  return [];
}

function isBarrier(step: Step): boolean {
  if (step.kind === "assert" || step.kind === "loop" || step.kind === "island") return true;
  if (step.kind === "tool") return isBarrierName(step.tool);
  return false;
}

/**
 * Whether a loop's iterations may run concurrently, and how wide.
 *
 * Safety here is an allowlist, not a denylist. `isMutating` is a list of verbs
 * (write, create, post, …) and misses plenty of things that change the world —
 * charge, refund, merge, deploy, approve — so it is the wrong basis for a
 * decision about whether an operation can be repeated out of order. A step
 * qualifies only if it is positively known to be side-effect free:
 *
 *   - a tool the program explicitly marked `readOnly`, which is the compiler's
 *     or the registry's assertion to make, not the runtime's to guess; or
 *   - a tool whose name matches the read vocabulary (fetch/get/list/…); or
 *   - an island, which is a model call with no tool access; or
 *   - an assert, which only reads.
 *
 * Anything else — including any tool the runtime simply does not recognise —
 * keeps the sequential path.
 */
function stepIsParallelSafe(step: Step): boolean {
  if (step.kind === "assert" || step.kind === "island") return true;
  if (step.kind === "tool") return step.readOnly === true || isReadName(step.tool);
  return false; // a nested loop: leave the inner one to make its own decision
}

export function loopConcurrency(
  loop: Step & { kind: "loop" },
  body: readonly Step[],
  itemCount: number,
  opts: Pick<RunOpts, "loopConcurrency">,
): number {
  const limit = opts.loopConcurrency ?? DEFAULT_LOOP_CONCURRENCY;
  if (limit <= 1 || itemCount < 2) return 1;
  if (loop.parallel === false) return 1;
  if (!body.length || !body.every(stepIsParallelSafe)) return 1;
  return Math.min(limit, itemCount);
}

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T> {
  const ac = new AbortController();
  if (!timeoutMs || timeoutMs <= 0) return work(ac.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      work(ac.signal).catch((err) => {
        if (timedOut || ac.signal.aborted) throw new DeoptError(`timeout ${timeoutMs}ms`);
        throw err;
      }),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
          reject(new DeoptError(`timeout ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runProgram(
  program: StretchProgram,
  input: Record<string, unknown>,
  opts: RunOpts,
): Promise<RunResult> {
  assertValid(program);
  const t0 = performance.now();
  const stats: RunStats = { llmCalls: 0, toolCalls: [], ms: 0, cents: 0, deopt: false, skipped: [] };
  if (opts.checkEnvelope !== false && !inDistribution(program, input)) {
    const keys = Object.keys(program.contract.envelope?.inputs ?? {});
    throw new DeoptError(`input not in witness envelope${keys.length ? ` (${keys.join(",")})` : ""}`);
  }
  const results = new Map<string, unknown>();
  const scope: BindScope = { input, results };
  const byId = new Map(program.steps.map((s) => [s.id, s]));
  const bodyOwned = new Set<string>();
  for (const s of program.steps) if (s.kind === "loop") for (const id of s.body) bodyOwned.add(id);
  /**
   * "The result of the step before this one", which a bare-path assert reads.
   *
   * A box rather than a closure variable, because a parallel loop body needs
   * its own. It was shared: N iterations interleaved and every one of them
   * wrote here, so an assert inside a concurrent body — which
   * stepIsParallelSafe explicitly permits — evaluated against whichever
   * iteration happened to return most recently, and passed or failed
   * nondeterministically. The wave scheduler already guards against exactly
   * this for its own steps; loop iterations were missed.
   */
  const topLast: { value: unknown } = { value: undefined };
  /** Tool calls issued, whether or not they returned. See DeoptError.stepsRun. */
  let toolCallsIssued = 0;

  const execStep = async (
    step: Step,
    signal: AbortSignal,
    scope: BindScope,
    touchLast = true,
    last: { value: unknown } = topLast,
  ): Promise<unknown> => {
    if (signal.aborted) throw new DeoptError("aborted");
    if (step.kind === "tool") {
      const args = evalArgs(step.args, scope);
      // Counted before the call, not after it. stats.toolCalls is only appended
      // once a step returns, so a tool that ran and *then* threw would look
      // like it never happened — precisely the case where a caller must not
      // replay the sequence.
      toolCallsIssued++;
      const value = await opts.registry.execute(step.tool, args, { signal });
      if (signal.aborted) throw new DeoptError("aborted");
      scope.results.set(step.id, value);
      if (touchLast) last.value = value;
      return value;
    }
    if (step.kind === "island") {
      if (!opts.island) throw new DeoptError(`island ${step.id} needs an island caller`);
      if (signal.aborted) throw new DeoptError("aborted");
      const islandInput = evalBinding(step.input, scope);
      stats.llmCalls += 1;
      stats.cents += opts.llmCents ?? 1;
      const value = await opts.island({ system: step.system, input: islandInput, outputSchema: step.outputSchema, signal });
      if (signal.aborted) throw new DeoptError("aborted");
      scope.results.set(step.id, value);
      if (touchLast) last.value = value;
      return value;
    }
    if (step.kind === "assert") {
      const ok = evalAssert(step.expr, last.value, input, scope.results);
      if (!ok) {
        const reason = `assert failed: ${step.expr}`;
        if (step.onFail === "deopt") throw new DeoptError(reason);
        throw new Error(reason);
      }
      scope.results.set(step.id, true);
      return true;
    }
    const items = asArray(evalBinding(step.over, scope));
    const body = step.body.map((id) => {
      const s = byId.get(id);
      if (!s) throw new Error(`loop body missing ${id}`);
      return s;
    });
    const width = loopConcurrency(step, body, items.length, opts);

    // One iteration, against whichever scope it was given.
    const runIteration = async (item: unknown, iterScope: BindScope, signal: AbortSignal) => {
      iterScope.results.set(step.item, item);
      const calls: string[] = [];
      // This iteration's own box, so a concurrent sibling cannot become the
      // "previous step" that an assert in this body reads.
      const iterLast: { value: unknown } = { value: undefined };
      for (const s of body) {
        await execStep(s, signal, iterScope, true, iterLast);
        if (s.kind === "tool") calls.push(s.tool);
      }
      return { last: iterLast.value, calls };
    };

    const collected: unknown[] = new Array(items.length);
    const callsPerItem: string[][] = new Array(items.length);

    if (width <= 1) {
      const iterScope: BindScope = scope;
      try {
        for (let i = 0; i < items.length; i++) {
          const out = await runIteration(items[i], iterScope, signal);
          collected[i] = out.last;
          callsPerItem[i] = out.calls;
        }
      } finally {
        iterScope.results.delete(step.item);
      }
    } else {
      // Each iteration gets its own layer so concurrent writes to the body step
      // ids cannot see one another. The last iteration's layer is merged back
      // afterwards, which is the state a sequential run would have left.
      const layers: Array<ChildScope | undefined> = new Array(items.length);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          if (signal.aborted) throw new DeoptError("aborted");
          const layer = new ChildScope(scope.results);
          layers[i] = layer;
          const out = await runIteration(items[i], { input, results: layer }, signal);
          collected[i] = out.last;
          callsPerItem[i] = out.calls;
        }
      };
      await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
      const tail = layers[items.length - 1];
      if (tail) {
        for (const [k, v] of tail.entries()) if (k !== step.item) scope.results.set(k, v);
      }
    }

    // Ordered by item index, not by completion, so a receipt from a parallel
    // run is byte-identical to one from a sequential run.
    for (const calls of callsPerItem) if (calls) stats.toolCalls.push(...calls);
    scope.results.set(step.id, collected);
    if (touchLast) last.value = collected;
    return collected;
  };

  const pending = program.steps.filter((s) => !bodyOwned.has(s.id));

  const runBody = async (signal: AbortSignal): Promise<RunResult> => {
    let i = 0;
    while (i < pending.length) {
      if (signal.aborted) throw new DeoptError("aborted");
      const step = pending[i]!;
      if (isBarrier(step)) {
        await execStep(step, signal, scope);
        if (step.kind === "tool") stats.toolCalls.push(step.tool);
        i++;
        continue;
      }
      const wave: Step[] = [];
      const waveIds = new Set<string>();
      while (i < pending.length) {
        const s = pending[i]!;
        // The same allowlist a loop body has to pass, and for the same reason
        // stepIsParallelSafe spells out: isBarrier rests on isMutating, a list
        // of verbs that misses charge, refund, merge, deploy and approve. Two
        // independent `charge*` steps whose arguments both come from `input`
        // were batched into one wave and run concurrently, with
        // nondeterministic ordering and partial-effect-on-error semantics.
        // Loop bodies were held to the stricter test and top-level waves were
        // not.
        if (isBarrier(s) || !stepIsParallelSafe(s)) break;
        const deps = stepDeps(s);
        if (deps.some((d) => !results.has(d))) break;
        if (deps.some((d) => waveIds.has(d))) break;
        wave.push(s);
        waveIds.add(s.id);
        i++;
      }
      if (!wave.length) {
        await execStep(step, signal, scope);
        if (step.kind === "tool") stats.toolCalls.push(step.tool);
        i++;
        continue;
      }
      if (wave.length === 1) {
        await execStep(wave[0]!, signal, scope);
      } else {
        // Steps in a wave race, so none of them may claim `lastResult` as it
        // finishes — the winner would be nondeterministic. Assign it afterwards
        // from the last step in program order, which is what a sequential run
        // would have left behind for a following bare-path assert to read.
        await Promise.all(wave.map((s) => execStep(s, signal, scope, false)));
        topLast.value = results.get(wave[wave.length - 1]!.id);
      }
      for (const s of wave) if (s.kind === "tool") stats.toolCalls.push(s.tool);
    }
    const value = evalBinding(program.returns, scope);
    stats.ms = performance.now() - t0;
    return { value, stats };
  };

  try {
    return await withTimeout(runBody, opts.timeoutMs);
  } catch (err) {
    stats.ms = performance.now() - t0;
    if (err instanceof DeoptError) {
      stats.deopt = true;
      stats.deoptReason = err.reason;
      // Tell the caller whether the world has been touched. Without this a
      // fallback path has to infer it from the reason string, and gets it
      // wrong for any bail that happens after the first tool call.
      err.stepsRun = toolCallsIssued;
      throw err;
    }
    throw err;
  }
}
