import type { Manifest, StretchProgram, StretchTrace, ToolRegistry, IslandCaller } from "@eden/ir";
import { canonicalize, inDistribution, isCheckName, isIslandName, isMutating, minLlmReductionOf, redact } from "@eden/ir";
import { isDeopt, runProgram } from "@eden/runtime";

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export type ShadowResult = {
  verdict: Verdict;
  manifest: Manifest | null;
  reasons: string[];
  n: number;
  minLlmReduction?: number;
};

export type ShadowOpts = {
  registry: ToolRegistry;
  island?: IslandCaller;
  minN?: number;
  requiredTools?: string[];
  registryFor?: (t: StretchTrace) => ToolRegistry;
  islandFor?: (t: StretchTrace) => IslandCaller | undefined;
  /**
   * Permit shadowing a program that performs writes.
   *
   * Shadowing replays the candidate once per held-out trace against whatever
   * registry it is given, and callers hand it the real one. For a mined
   * stretch like [get_issue, update_issue, notify] that is n real updates and
   * n real notifications, performed to decide whether the program is good
   * enough to be allowed to perform them. Off by default: a caller that has
   * arranged a replay or sandbox registry says so explicitly.
   */
  allowSideEffects?: boolean;
};

/** Steps that would change something on the far side if replayed for real. */
export function mutatingSteps(program: StretchProgram): string[] {
  return [
    ...new Set(
      program.steps
        .filter((s) => s.kind === "tool" && s.readOnly !== true && isMutating(s.tool))
        .map((s) => (s as { tool: string }).tool),
    ),
  ];
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function reductionRatio(naive: number, compiled: number): number {
  if (!(naive > 0)) return 1;
  if (!(compiled > 0)) return Math.min(99, Math.max(naive, 2));
  return naive / compiled;
}

export function uncoveredTools(registry: ToolRegistry | undefined, program: StretchProgram): string[] {
  const names = program.sequence ?? program.steps.filter((s) => s.kind === "tool").map((s) => s.tool);
  return names.filter((n) => !isIslandName(n) && !registry?.has?.(n));
}

export function registryCovers(registry: ToolRegistry, program: StretchProgram): boolean {
  return uncoveredTools(registry, program).length === 0;
}

export async function shadowProgram(
  program: StretchProgram,
  traces: StretchTrace[],
  opts: ShadowOpts,
): Promise<ShadowResult> {
  const held = traces.filter((t) => t.input && inDistribution(program, t.input));
  const minN = opts.minN ?? 3;
  const reasons: string[] = [];
  // Refuse before running anything. Every held-out trace is a full replay, so
  // a program with an unguarded write performs that write once per trace — to
  // decide whether it is trustworthy enough to be allowed to perform it.
  const writes = opts.allowSideEffects ? [] : mutatingSteps(program);
  if (writes.length) {
    return {
      verdict: "INCONCLUSIVE",
      manifest: null,
      reasons: [
        `shadowing would perform ${writes.join(", ")} for real, once per held-out trace — supply a sandbox registry (registryFor) and set allowSideEffects`,
      ],
      n: held.length,
      minLlmReduction: minLlmReductionOf(program.contract.minLlmReduction),
    };
  }
  if (held.length < minN) {
    return { verdict: "INCONCLUSIVE", manifest: null, reasons: [`n=${held.length} < ${minN}`], n: held.length, minLlmReduction: minLlmReductionOf(program.contract.minLlmReduction) };
  }

  const compiledLlm: number[] = [];
  const compiledMs: number[] = [];
  const compiledCents: number[] = [];
  const naiveLlm: number[] = [];
  const naiveMs: number[] = [];
  const naiveCents: number[] = [];
  let compiledComplete = 0;
  let naiveComplete = 0;
  let compiledSkips = 0;
  let naiveSkips = 0;
  let extraMisses = 0;
  const required =
    opts.requiredTools ?? program.sequence?.filter((n) => isCheckName(n)) ?? [];
  const hasIsland = program.steps.some((s) => s.kind === "island");

  for (const t of held) {
    naiveLlm.push(t.llmCalls);
    naiveMs.push(t.duration_ms);
    naiveCents.push(t.cost_cents);
    if (t.complete === true) naiveComplete++;
    naiveSkips += t.skipped?.length ?? 0;
    try {
      const run = await runProgram(program, t.input ?? {}, {
        registry: opts.registryFor?.(t) ?? opts.registry,
        island: opts.islandFor?.(t) ?? opts.island,
        checkEnvelope: true,
        timeoutMs: 60_000,
      });
      compiledLlm.push(run.stats.llmCalls);
      compiledMs.push(run.stats.ms);
      compiledCents.push(run.stats.cents);
      // Whether the compiled program returns the *right answer* was never
      // checked: nothing here read t.output. A program whose  binding
      // points at the wrong step runs cleanly, returns undefined, and passed.
      // "Completed" now means "agreed with the trace it was compiled from",
      // which is also what makes the naiveComplete comparison below meaningful
      // — it used to count every run that merely did not throw, against a
      // naive count of traces flagged complete, so the two were not the same
      // predicate and the gate could not fire.
      if (outputMatches(run.value, t.output)) compiledComplete++;
      else {
        extraMisses++;
        if (reasons.length < 8) reasons.push("compiled output differs from the recorded trace");
      }
      for (const req of required) {
        if (!run.stats.toolCalls.includes(req)) {
          compiledSkips++;
          extraMisses++;
        }
      }
      if (hasIsland && run.stats.llmCalls < 1) {
        extraMisses++;
        if (reasons.length < 8) reasons.push("island program produced 0 LLM calls");
      }
    } catch (err) {
      if (isDeopt(err)) {
        extraMisses++;
        if (reasons.length < 8) reasons.push(`deopt on in-distribution input: ${(err as Error).message}`);
        continue;
      }
      extraMisses++;
      if (reasons.length < 8) reasons.push(`compiled error: ${(err as Error).message}`);
    }
  }

  const n = held.length;
  const llmReduction = reductionRatio(mean(naiveLlm), mean(compiledLlm));
  // Reported, never gated on — and read it with care. `naiveMs` is whatever the
  // recorder wrote into the trace (for the TicketShip fixture, a synthetic
  // 200ms per LLM call), while `compiledMs` is real in-process execution. The
  // two are not the same clock, so the ratio can reach absurd values and means
  // nothing unless the traces carry genuinely measured durations. Only
  // llmReduction and skipRateAfter decide whether a program may ship.
  const latencyReduction = reductionRatio(mean(naiveMs), mean(compiledMs));
  const costReduction = reductionRatio(mean(naiveCents), mean(compiledCents));
  const skipRateBefore = naiveSkips / n;
  const skipRateAfter = compiledSkips / n;
  const minR = minLlmReductionOf(program.contract.minLlmReduction);

  const manifest: Manifest = {
    llmReduction,
    latencyReduction,
    costReduction,
    skipRateBefore,
    skipRateAfter,
    nShadow: n,
  };

  if (extraMisses > 0) {
    reasons.push(`extra misses ${extraMisses}`);
    return { verdict: "FAIL", manifest, reasons, n, minLlmReduction: minR };
  }
  if (naiveComplete > 0 && compiledComplete < naiveComplete) {
    reasons.push(`complete ${compiledComplete} < naive ${naiveComplete}`);
    return { verdict: "FAIL", manifest, reasons, n, minLlmReduction: minR };
  }
  if (llmReduction < minR) {
    reasons.push(
      `reductions llm=${llmReduction.toFixed(2)} lat=${latencyReduction.toFixed(2)} cost=${costReduction.toFixed(2)} need ≥${minR}× LLM`,
    );
    return { verdict: "FAIL", manifest, reasons, n, minLlmReduction: minR };
  }
  if (skipRateAfter > 0) {
    reasons.push(`compiled skip rate ${skipRateAfter}`);
    return { verdict: "FAIL", manifest, reasons, n, minLlmReduction: minR };
  }
  return { verdict: "PASS", manifest, reasons, n, minLlmReduction: minR };
}

export function canApprove(result: ShadowResult): boolean {
  const m = result.manifest;
  if (result.verdict !== "PASS" || !m) return false;
  const minR = minLlmReductionOf(result.minLlmReduction);
  return m.llmReduction >= minR && m.skipRateAfter === 0;
}

/**
 * Did the compiled program return what the trace recorded?
 *
 * Compared through redact() so a credential that was redacted on the way into
 * the trace does not read as a difference, and through canonicalize() so key
 * order does not either. A trace with no recorded output cannot answer the
 * question, so it is not counted against the program.
 */
function outputMatches(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  try {
    return canonicalize(redact(actual)) === canonicalize(redact(expected));
  } catch {
    return false;
  }
}
