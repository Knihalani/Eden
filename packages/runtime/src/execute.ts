import type { Binding, IslandCaller, Step, StretchProgram, ToolRegistry } from "@eden/ir";
import { asArray, assertValid, inDistribution, isBarrierName, isReadName, unwrapIsland } from "@eden/ir";
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
  /** Wall of real island calls during this run. 0 if none ran. */
  islandMs: number;
  cents: number;
  deopt: boolean;
  deoptReason?: string;
  skipped: string[];
  /** Tool calls issued (including ones that then deopted). */
  stepsRun: number;
  /** True when a deopt happened before any tool call. */
  early: boolean;
  /** Scraped island prompt tokens (sum). Meaningful when islandUsageMeasured. */
  islandPromptTokens: number;
  islandCompletionTokens: number;
  islandCachedTokens: number;
  islandCacheWriteTokens: number;
  islandCacheInputTokens: number;
  /** True if every island call that ran was a witness-memo hit. */
  islandMemoized: boolean;
  /** True when every completed island call reported finite prompt+completion. */
  islandUsageMeasured: boolean;
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
  /**
   * Cancellation from an enclosing run. When a composed parent is aborted,
   * the sub-program must abort with it — not keep executing to its own
   * timeout while the parent has already given up.
   */
  signal?: AbortSignal;
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
  // Islands are not barriers: independent island misses in one program wave
  // may run together so wrap can coalesce them onto the batch transport.
  if (step.kind === "assert" || step.kind === "loop" || step.kind === "branch") return true;
  if (step.kind === "tool") {
    // The program (or registry) asserted this call has no side effects.
    // A mutating-looking name must not override that and serialize the wave —
    // that is the whole point of `readOnly`. `charge` is a mutating verb;
    // without this pin the mark was dead at top level.
    if (step.readOnly === true) return false;
    return isBarrierName(step.tool);
  }
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
  if (loop.until) return 1;
  const limit = opts.loopConcurrency ?? DEFAULT_LOOP_CONCURRENCY;
  if (limit <= 1 || itemCount < 2) return 1;
  if (loop.parallel === false) return 1;
  if (!body.length || !body.every(stepIsParallelSafe)) return 1;
  return Math.min(limit, itemCount);
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs?: number,
  external?: AbortSignal,
): Promise<T> {
  const ac = new AbortController();
  // An externally-supplied signal (a parent composed run being cancelled)
  // forwards into this run: cancelling the parent must cancel the child,
  // not leave it executing to its own timeout.
  const onExternalAbort = () => ac.abort();
  if (external) {
    if (external.aborted) ac.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  if (!timeoutMs || timeoutMs <= 0) {
    try {
      return await work(ac.signal);
    } finally {
      external?.removeEventListener("abort", onExternalAbort);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      work(ac.signal).catch((err) => {
        if (external?.aborted) throw new DeoptError("aborted");
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
    external?.removeEventListener("abort", onExternalAbort);
  }
}

export async function runProgram(
  program: StretchProgram,
  input: Record<string, unknown>,
  opts: RunOpts,
): Promise<RunResult> {
  assertValid(program);
  const t0 = performance.now();
  const stats: RunStats = {
    llmCalls: 0,
    toolCalls: [],
    ms: 0,
    islandMs: 0,
    cents: 0,
    deopt: false,
    skipped: [],
    stepsRun: 0,
    early: false,
    islandPromptTokens: 0,
    islandCompletionTokens: 0,
    islandCachedTokens: 0,
    islandCacheWriteTokens: 0,
    islandCacheInputTokens: 0,
    islandMemoized: false,
    islandUsageMeasured: false,
  };
  let islandCompleted = 0;
  let islandUsageOk = true;
  let islandAllMemo = true;
  if (opts.checkEnvelope !== false && !inDistribution(program, input)) {
    const keys = Object.keys(program.contract.envelope?.inputs ?? {});
    throw new DeoptError(`input not in witness envelope${keys.length ? ` (${keys.join(",")})` : ""}`);
  }
  const results = new Map<string, unknown>();
  const scope: BindScope = { input, results };
  const byId = new Map(program.steps.map((s) => [s.id, s]));
  const bodyOwned = new Set<string>();
  for (const s of program.steps) {
    if (s.kind === "loop") for (const id of s.body) bodyOwned.add(id);
    // Branch arms are owned by their branch: they never run at top level.
    if (s.kind === "branch") {
      for (const id of s.then) bodyOwned.add(id);
      for (const id of s.else ?? []) bodyOwned.add(id);
      for (const c of s.cases ?? []) for (const id of c.steps) bodyOwned.add(id);
    }
  }
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
    wait = false,
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
      const unit = opts.llmCents ?? 1;
      // Charge sync price up front so a throw still accounts the attempt.
      // Batched misses rebate to the provider Message Batches price (half).
      stats.cents += unit;
      const islandT0 = performance.now();
      const out = await opts.island({
        system: step.system,
        input: islandInput,
        outputSchema: step.outputSchema,
        signal,
        ...(step.pinned === true ? { pinned: true } : {}),
        ...(wait ? { wait: true } : {}),
      });
      stats.islandMs += performance.now() - islandT0;
      if (signal.aborted) throw new DeoptError("aborted");
      const { value, usage } = unwrapIsland(out);
      islandCompleted++;
      const prompt = usage?.prompt_tokens;
      const completion = usage?.completion_tokens;
      if (usage && Number.isFinite(prompt) && Number.isFinite(completion)) {
        stats.islandPromptTokens += prompt;
        stats.islandCompletionTokens += completion;
        stats.islandCachedTokens += usage.cached_tokens ?? 0;
        stats.islandCacheWriteTokens += usage.cache_write_tokens ?? 0;
        stats.islandCacheInputTokens += usage.cache_input_tokens ?? 0;
        if (usage.memoized === true) {
          // Witness lookup is not a billed island call.
          stats.cents -= unit;
        } else {
          islandAllMemo = false;
          // Provider Message Batches contract: billed cents are half of sync.
          // Token counts stay the full provider report.
          if (usage.batched === true) stats.cents -= unit * 0.5;
        }
      } else {
        islandUsageOk = false;
        islandAllMemo = false;
      }
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
    if (step.kind === "branch") {
      // Same expression grammar asserts use. First matching expr wins: `expr`
      // then `cases` in order, then `else`. Nested branch-in-else (old binary
      // programs) still runs because the inner step id is just an else arm.
      const cond = evalAssert(step.expr, last.value, input, scope.results);
      let armIds: string[] = step.then;
      if (!cond) {
        armIds = step.else ?? [];
        for (const c of step.cases ?? []) {
          if (evalAssert(c.expr, last.value, input, scope.results)) {
            armIds = c.steps;
            break;
          }
        }
      }
      // Arms execute sequentially against their own last-box so an assert
      // inside an arm reads the arm's own previous step, not whatever raced
      // by outside.
      const armLast: { value: unknown } = { value: last.value };
      const armTools: string[] = [];
      for (const id of armIds) {
        const owned = byId.get(id);
        if (!owned) throw new DeoptError(`branch ${step.id} references missing step ${id}`);
        await execStep(owned, signal, scope, true, armLast);
        if (owned.kind === "tool") {
          // execStep already counted the call before issuing it; counting
          // again here made every deopt near a branch report ~2× stepsRun,
          // skewing replay-safety boundaries and receipts.
          armTools.push(owned.tool);
        }
      }
      const armValue = armLast.value;
      scope.results.set(step.id, armValue);
      if (touchLast) last.value = armValue;
      // Program-order accounting, matching what a linear run would report.
      stats.toolCalls.push(...armTools);
      return armValue;
    }
    if (step.kind !== "loop") throw new Error(`unexpected step kind ${(step as Step).kind}`);
    const body = step.body.map((id) => {
      const s = byId.get(id);
      if (!s) throw new Error(`loop body missing ${id}`);
      return s;
    });

    if (step.until) {
      const maxIters = step.maxIters ?? 32;
      const collected: unknown[] = [];
      // Retry-until: a single-tool body that throws (429) is one failed
      // iteration with `{ ok: false }`, not a deopt. Poll loops (k8s) call
      // ok:true with ready:false and never take this catch.
      const retryOnThrow = body.length === 1 && body[0]!.kind === "tool";
      try {
        for (let i = 0; i < maxIters; i++) {
          if (signal.aborted) throw new DeoptError("aborted");
          scope.results.set(step.item, i);
          const iterLast: { value: unknown } = { value: undefined };
          const calls: string[] = [];
          try {
            for (const s of body) {
              await execStep(s, signal, scope, true, iterLast);
              if (s.kind === "tool") calls.push(s.tool);
            }
          } catch (err) {
            if (!retryOnThrow || err instanceof DeoptError) throw err;
            const fail = { ok: false, error: err instanceof Error ? err.message : String(err) };
            for (const s of body) {
              if (s.kind === "tool") {
                scope.results.set(s.id, fail);
                calls.push(s.tool);
              }
            }
            iterLast.value = fail;
          }
          collected.push(iterLast.value);
          stats.toolCalls.push(...calls);
          if (evalAssert(step.until, iterLast.value, input, scope.results)) {
            scope.results.set(step.id, collected);
            if (touchLast) last.value = collected;
            return collected;
          }
        }
        throw new DeoptError(`poll ${step.until} exceeded maxIters ${maxIters}`);
      } finally {
        scope.results.delete(step.item);
      }
    }

    const items = asArray(evalBinding(step.over, scope));
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
        // Independent islands in this wave may wait for each other (batch path).
        // A lone island in the wave stays sync — n=1 after coalesce is also sync.
        const waitIslands = wave.filter((s) => s.kind === "island").length >= 2;
        await Promise.all(wave.map((s) => execStep(s, signal, scope, false, topLast, waitIslands)));
        topLast.value = results.get(wave[wave.length - 1]!.id);
      }
      for (const s of wave) if (s.kind === "tool") stats.toolCalls.push(s.tool);
    }
    const value = evalBinding(program.returns, scope);
    stats.ms = performance.now() - t0;
    stats.stepsRun = toolCallsIssued;
    stats.early = false;
    stats.islandMemoized = islandCompleted > 0 && islandAllMemo;
    stats.islandUsageMeasured = islandCompleted > 0 && islandCompleted === stats.llmCalls && islandUsageOk;
    return { value, stats };
  };

  try {
    return await withTimeout(runBody, opts.timeoutMs, opts.signal);
  } catch (err) {
    stats.ms = performance.now() - t0;
    if (err instanceof DeoptError) {
      stats.deopt = true;
      stats.deoptReason = err.reason;
      // Tell the caller whether the world has been touched. Without this a
      // fallback path has to infer it from the reason string, and gets it
      // wrong for any bail that happens after the first tool call.
      err.stepsRun = toolCallsIssued;
      err.ms = stats.ms;
      err.llmCalls = stats.llmCalls;
      err.cents = stats.cents;
      // Which steps COMPLETED (returned), not just which were entered —
      // suppressed siblings must re-run anything absent from this list.
      err.toolCalls = [...stats.toolCalls];
      stats.stepsRun = toolCallsIssued;
      stats.early = toolCallsIssued === 0;
      throw err;
    }
    // Any other failure escaping the body — a binding bug, an evalArgs throw,
    // anything we did not anticipate — carries the SAME obligation: the caller
    // and any suppressed siblings must know exactly how far the run got.
    // Leaving these as plain Errors made their touched-ness unknowable, which
    // forced every downstream fallback into guessing.
    const wrapped = new DeoptError(
      `step failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Preserve the original so semantic classifiers (e.g. shadow's
    // UnrecordedCall, meaning "this trace cannot validate the program")
    // can still recognise what actually happened through the cause chain.
    (wrapped as { cause?: unknown }).cause = err;
    wrapped.stepsRun = toolCallsIssued;
    wrapped.ms = stats.ms;
    wrapped.llmCalls = stats.llmCalls;
    wrapped.cents = stats.cents;
    wrapped.toolCalls = [...stats.toolCalls];
    stats.deopt = true;
    stats.deoptReason = wrapped.reason;
    stats.stepsRun = toolCallsIssued;
    stats.early = toolCallsIssued === 0;
    throw wrapped;
  }
}
