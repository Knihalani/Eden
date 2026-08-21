import type { Manifest, StretchProgram, StretchTrace, ToolRegistry, IslandCaller } from "@eden/ir";
import { canonicalize, inDistribution, isCheckName, isIslandName, isMutating, isUsableOutput, minLlmReductionOf, redact } from "@eden/ir";
import { isDeopt, runProgram } from "@eden/runtime";
import { isUnrecordedCall } from "./replay";
import { compiledTokens, compiledToolMs, isSyntheticDuration, naiveToolMs, traceTokens } from "./measure";

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
  // `??` only falls back on nullish, so an empty `sequence` — which a program
  // may legitimately carry — meant "no tools to cover" and the coverage check
  // passed trivially. api.ts gates shadowing on that check being empty, so a
  // program whose steps included a tool the registry had never heard of was
  // shadowed anyway.
  const names = program.sequence?.length
    ? program.sequence
    : program.steps.filter((s) => s.kind === "tool").map((s) => s.tool);
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
  const naiveTok: number[] = [];
  const compiledTok: number[] = [];
  const naiveTime: number[] = [];
  const compiledTime: number[] = [];
  let tokensMeasured = true;
  let timeMeasured = true;
  let compiledComplete = 0;
  let naiveComplete = 0;
  let compiledSkips = 0;
  let naiveSkips = 0;
  let extraMisses = 0;
  /**
   * Traces the recording could not answer, because the compiled program made a
   * call the agent never made.
   *
   * Counted apart from extraMisses on purpose. A compiled program runs the
   * checks the agent skipped — TicketShip's whole fixture is built around an
   * agent that skips verifyWrite a fifth of the time — and
   * skipRateBefore/skipRateAfter exist to *reward* exactly that. Treating it
   * as a miss meant the gate failed programs for the one improvement the
   * product is sold on. It is absence of evidence, not evidence of a fault:
   * the trace simply cannot validate this program, so it is set aside.
   */
  let unvalidatable = 0;
  let validated = 0;
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
      const naiveT = traceTokens(t);
      const compiledT = compiledTokens(t, run.stats.llmCalls, hasIsland);
      if (naiveT == null || compiledT == null) tokensMeasured = false;
      else {
        naiveTok.push(naiveT);
        compiledTok.push(compiledT);
      }
      const toolsMs = compiledToolMs(t, run.stats.toolCalls);
      const naiveTools = naiveToolMs(t);
      if (isSyntheticDuration(t) || naiveTools == null || toolsMs == null) timeMeasured = false;
      else {
        naiveTime.push(naiveTools);
        compiledTime.push(toolsMs + (hasIsland && run.stats.llmCalls >= 1 ? run.stats.islandMs : 0));
      }
      validated++;
      const usable = isUsableOutput(run.value);
      if (!usable) {
        extraMisses++;
        if (reasons.length < 8) reasons.push("succeeded with nothing");
      }
      const match = outputMatches(run.value, t.output);
      if (match === "vacuous") {
        extraMisses++;
        if (reasons.length < 8) reasons.push("trace has no recorded output — quality cannot be scored");
      } else if (match) compiledComplete++;
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
      if (isUnrecordedCall(err)) {
        unvalidatable++;
        if (reasons.length < 8) {
          reasons.push(`compiled program ran ${(err as { tool?: string }).tool ?? "a step"} that this trace never recorded`);
        }
        continue;
      }
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
  // A verdict needs traces that actually exercised the program end to end. If
  // the recording could not answer most of them, the honest answer is that we
  // do not know — not that everything passed by default.
  if (validated < minN) {
    return {
      verdict: "INCONCLUSIVE",
      manifest: null,
      reasons: [
        ...reasons,
        `only ${validated} of ${n} held-out traces could validate this program (${unvalidatable} made calls the recording does not contain)`,
      ],
      n,
      minLlmReduction: minLlmReductionOf(program.contract.minLlmReduction),
    };
  }
  const llmReduction = reductionRatio(mean(naiveLlm), mean(compiledLlm));
  const timeSavedMs = timeMeasured && naiveTime.length ? mean(naiveTime) - mean(compiledTime) : null;
  const tokensSaved = tokensMeasured && naiveTok.length ? mean(naiveTok) - mean(compiledTok) : null;
  const latencyReduction =
    timeMeasured && compiledTime.length ? reductionRatio(mean(naiveTime), mean(compiledTime)) : reductionRatio(mean(naiveMs), mean(compiledMs));
  const costReduction = reductionRatio(mean(naiveCents), mean(compiledCents));
  const skipRateBefore = naiveSkips / n;
  const skipRateAfter = compiledSkips / Math.max(validated, 1);
  const minR = minLlmReductionOf(program.contract.minLlmReduction);

  const manifest: Manifest = {
    llmReduction,
    latencyReduction,
    costReduction,
    skipRateBefore,
    skipRateAfter,
    nShadow: n,
    tokensSaved,
    timeSavedMs,
    tokensMeasured,
    timeMeasured,
  };

  if (extraMisses > 0) {
    reasons.push(`extra misses ${extraMisses}`);
    return { verdict: "FAIL", manifest, reasons, n, minLlmReduction: minR };
  }
  if (naiveComplete > 0 && compiledComplete < Math.min(naiveComplete, validated)) {
    reasons.push(`complete ${compiledComplete} < naive ${naiveComplete}`);
    return { verdict: "FAIL", manifest, reasons, n, minLlmReduction: minR };
  }
  if (skipRateAfter > 0) {
    reasons.push(`compiled skip rate ${skipRateAfter}`);
    return { verdict: "FAIL", manifest, reasons, n, minLlmReduction: minR };
  }
  const tokensOk = tokensMeasured && tokensSaved != null && tokensSaved > 0;
  const timeOk = timeMeasured && timeSavedMs != null && timeSavedMs > 0;
  if (!tokensOk && !timeOk) {
    reasons.push("not measured — quality held but neither tokens nor time saved");
    return { verdict: "INCONCLUSIVE", manifest, reasons, n, minLlmReduction: minR };
  }
  return { verdict: "PASS", manifest, reasons, n, minLlmReduction: minR };
}

export function canApprove(result: ShadowResult): boolean {
  const m = result.manifest;
  if (result.verdict !== "PASS" || !m) return false;
  if (m.skipRateAfter !== 0) return false;
  const tokensOk = Boolean(m.tokensMeasured) && (m.tokensSaved ?? 0) > 0;
  const timeOk = Boolean(m.timeMeasured) && (m.timeSavedMs ?? 0) > 0;
  return tokensOk || timeOk;
}

/**
 * Did the compiled program return what the trace recorded?
 *
 * Compared through redact() so a credential that was redacted on the way into
 * the trace does not read as a difference, and through canonicalize() so key
 * order does not either. A trace with no recorded output cannot answer — that
 * is not a pass.
 */
function outputMatches(actual: unknown, expected: unknown): boolean | "vacuous" {
  if (expected === undefined) return "vacuous";
  try {
    return canonicalize(redact(actual)) === canonicalize(redact(expected));
  } catch {
    return false;
  }
}
