import type { Binding, IslandCaller, Step, StretchProgram, ToolRegistry } from "@eden/ir";
import { asArray, assertValid, inDistribution, isBarrierName } from "@eden/ir";
import { evalArgs, evalBinding, type BindScope } from "./bind";
import { DeoptError } from "./deopt";
import { evalAssert } from "./assert";

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
  let lastResult: unknown;

  const execStep = async (step: Step, signal: AbortSignal, touchLast = true): Promise<unknown> => {
    if (signal.aborted) throw new DeoptError("aborted");
    if (step.kind === "tool") {
      const args = evalArgs(step.args, scope);
      const value = await opts.registry.execute(step.tool, args, { signal });
      if (signal.aborted) throw new DeoptError("aborted");
      results.set(step.id, value);
      if (touchLast) lastResult = value;
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
      results.set(step.id, value);
      if (touchLast) lastResult = value;
      return value;
    }
    if (step.kind === "assert") {
      const ok = evalAssert(step.expr, lastResult, input, results);
      if (!ok) {
        const reason = `assert failed: ${step.expr}`;
        if (step.onFail === "deopt") throw new DeoptError(reason);
        throw new Error(reason);
      }
      results.set(step.id, true);
      return true;
    }
    const items = asArray(evalBinding(step.over, scope));
    const collected: unknown[] = [];
    try {
      for (const item of items) {
        results.set(step.item, item);
        let last: unknown;
        for (const id of step.body) {
          const body = byId.get(id);
          if (!body) throw new Error(`loop body missing ${id}`);
          last = await execStep(body, signal);
          if (body.kind === "tool") stats.toolCalls.push(body.tool);
        }
        collected.push(last);
      }
    } finally {
      results.delete(step.item);
    }
    results.set(step.id, collected);
    lastResult = collected;
    return collected;
  };

  const pending = program.steps.filter((s) => !bodyOwned.has(s.id));

  const runBody = async (signal: AbortSignal): Promise<RunResult> => {
    let i = 0;
    while (i < pending.length) {
      if (signal.aborted) throw new DeoptError("aborted");
      const step = pending[i]!;
      if (isBarrier(step)) {
        await execStep(step, signal);
        if (step.kind === "tool") stats.toolCalls.push(step.tool);
        i++;
        continue;
      }
      const wave: Step[] = [];
      const waveIds = new Set<string>();
      while (i < pending.length) {
        const s = pending[i]!;
        if (isBarrier(s)) break;
        const deps = stepDeps(s);
        if (deps.some((d) => !results.has(d))) break;
        if (deps.some((d) => waveIds.has(d))) break;
        wave.push(s);
        waveIds.add(s.id);
        i++;
      }
      if (!wave.length) {
        await execStep(step, signal);
        if (step.kind === "tool") stats.toolCalls.push(step.tool);
        i++;
        continue;
      }
      if (wave.length === 1) {
        await execStep(wave[0]!, signal);
      } else {
        // Steps in a wave race, so none of them may claim `lastResult` as it
        // finishes — the winner would be nondeterministic. Assign it afterwards
        // from the last step in program order, which is what a sequential run
        // would have left behind for a following bare-path assert to read.
        await Promise.all(wave.map((s) => execStep(s, signal, false)));
        lastResult = results.get(wave[wave.length - 1]!.id);
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
      throw err;
    }
    throw err;
  }
}
