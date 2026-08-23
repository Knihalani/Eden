import type { Binding, Manifest, StretchProgram, StretchTrace, ToolRegistry, IslandCaller } from "@eden/ir";
import { canonicalize, inDistribution, isCheckName, isIslandName, isReadName, isUsableOutput, minLlmReductionOf, redact } from "@eden/ir";
import { isDeopt, runProgram } from "@eden/runtime";
import { isUnrecordedCall } from "./replay";
import { compiledTokens, compiledToolMs, isSyntheticDuration, naiveToolMs, tokensExtrapolated, traceTokens } from "./measure";

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/**
 * A manifest plus the honesty flag the island extrapolation forces: when
 * compiled tokens were scaled from remaining LLM calls rather than scraped
 * from provider usage, `tokensEstimated` says so and every gate downstream
 * treats the token delta as absent.
 */
export type ShadowManifest = Manifest & {
  /** True when `compiledTokens` produced the delta by scaling naive tokens. */
  tokensEstimated?: boolean;
};

export type ShadowResult = {
  verdict: Verdict;
  manifest: ShadowManifest | null;
  reasons: string[];
  n: number;
  minLlmReduction?: number;
  /** Mirrors `manifest.tokensEstimated` so callers need not dig into the manifest. */
  tokensEstimated?: boolean;
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

/**
 * Read vocabulary beyond the runtime's READ_NAME list, as defense in depth:
 * a tool the denylist never heard of used to count as safe, which is exactly
 * backwards. These extra verbs are names that only ever describe reading —
 * query, scan, inspect, select, view. Deliberately *not* including check or
 * parse verbs: `verifyWrite` and `parseFields` are not positively known to be
 * reads, and an allowlist that guesses is a denylist wearing a costume.
 */
const EXTRA_READ_NAME = /^(query|scan|inspect|select|view)/i;

function isReadStepName(tool: string): boolean {
  return isReadName(tool) || EXTRA_READ_NAME.test(tool);
}

/**
 * Steps that would change something on the far side if replayed for real.
 *
 * The refusal used to be inverted: every tool step was trusted UNLESS
 * `isMutating`'s verb list recognised it, so any tool that list had never
 * heard of was replayed for real. Safety here is an allowlist, mirroring
 * `stepIsParallelSafe` in runtime/execute.ts — a tool step is flagged unless
 *
 *   - the program explicitly marked it `readOnly`, or
 *   - its name positively matches read vocabulary (fetch/get/list/…), or
 *   - the caller set `allowSideEffects`, the explicit escape hatch for a
 *     caller that has arranged a sandbox and says so.
 */
export function mutatingSteps(program: StretchProgram): string[] {
  return [
    ...new Set(
      program.steps
        .filter((s) => s.kind === "tool" && s.readOnly !== true && !isReadStepName(s.tool))
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
  const compiledCents: number[] = [];
  const naiveLlm: number[] = [];
  const naiveCents: number[] = [];
  const naiveTok: number[] = [];
  const compiledTok: number[] = [];
  const naiveTime: number[] = [];
  const compiledTime: number[] = [];
  let tokensMeasured = true;
  let timeMeasured = true;
  let tokensEstimated = false;
  let compiledComplete = 0;
  let naiveComplete = 0;
  let compiledSkips = 0;
  /**
   * Skips the *naive* agent made, accumulated only for traces that reach
   * validation success. It used to accumulate over every held trace while
   * compiledSkips divided by the validated count, so the two rates did not
   * share a denominator and unvalidatable traces inflated the improvement.
   */
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
  // Proven once, statically: whether the final output chains back to an island
  // step decides only *how* outputs are compared, never whether they are.
  const islandDerivedOutput = outputDerivesFromIsland(program);

  for (const t of held) {
    if (t.complete === true) naiveComplete++;
    try {
      const run = await runProgram(program, t.input ?? {}, {
        registry: opts.registryFor?.(t) ?? opts.registry,
        island: opts.islandFor?.(t) ?? opts.island,
        checkEnvelope: true,
        timeoutMs: 60_000,
      });
      // Paired with the compiled pushes below, deliberately: the naive
      // numbers used to be pushed for EVERY held trace while their compiled
      // counterparts were pushed only on successful replay, so a PASS verdict
      // (which can coexist with unvalidatable traces) compared means over
      // DIFFERENT sample sets — llmReduction/costReduction biased by exactly
      // the traces that could not answer. Every ratio must be computed over
      // the same paired sample set: one push per side, or neither.
      naiveLlm.push(t.llmCalls);
      naiveCents.push(t.cost_cents);
      compiledLlm.push(run.stats.llmCalls);
      compiledCents.push(run.stats.cents);
      const naiveT = traceTokens(t);
      const compiledT = compiledTokens(t, run.stats.llmCalls, hasIsland);
      if (naiveT == null || compiledT == null) tokensMeasured = false;
      else {
        naiveTok.push(naiveT);
        compiledTok.push(compiledT);
        if (tokensExtrapolated(run.stats.llmCalls, hasIsland)) tokensEstimated = true;
      }
      const toolsMs = compiledToolMs(t, run.stats.toolCalls);
      const naiveTools = naiveToolMs(t);
      if (isSyntheticDuration(t) || naiveTools == null || toolsMs == null) timeMeasured = false;
      else {
        naiveTime.push(naiveTools);
        compiledTime.push(toolsMs + (hasIsland && run.stats.llmCalls >= 1 ? run.stats.islandMs : 0));
      }
      validated++;
      // Counted here, not at the top of the loop: naiveSkips and compiledSkips
      // must share one denominator, and only traces that reach validation
      // success are in it.
      naiveSkips += t.skipped?.length ?? 0;
      const usable = isUsableOutput(run.value);
      if (!usable) {
        extraMisses++;
        if (reasons.length < 8) reasons.push("succeeded with nothing");
      }
      const match = outputMatches(run.value, t.output, islandDerivedOutput);
      if (match === "vacuous") {
        extraMisses++;
        if (reasons.length < 8) reasons.push("trace has no recorded output — quality cannot be scored");
      } else if (match === "prose-divergent") {
        compiledComplete++;
        if (reasons.length < 8) reasons.push("prose-divergent: output derives from the island and was compared structurally, not byte-for-byte");
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
  // Synthetic fixture wall clock is not a measurement: when the per-step
  // durations needed to compare tool time honestly are absent, there is no
  // latency number — not one computed from naive wall clock vs compiled
  // replay wall clock, which is exactly an estimate wearing measurement's
  // clothes. Manifest.latencyReduction is number|null for this reason.
  const latencyReduction = timeMeasured && compiledTime.length ? reductionRatio(mean(naiveTime), mean(compiledTime)) : null;
  const costReduction = reductionRatio(mean(naiveCents), mean(compiledCents));
  // One denominator for both rates: traces that could validate the program.
  const validatedN = Math.max(validated, 1);
  const skipRateBefore = naiveSkips / validatedN;
  const skipRateAfter = compiledSkips / validatedN;
  const minR = minLlmReductionOf(program.contract.minLlmReduction);

  const manifest: ShadowManifest = {
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
    tokensEstimated,
  };

  if (extraMisses > 0) {
    reasons.push(`extra misses ${extraMisses}`);
    return { verdict: "FAIL", manifest, reasons, n, minLlmReduction: minR, tokensEstimated };
  }
  if (naiveComplete > 0 && compiledComplete < Math.min(naiveComplete, validated)) {
    reasons.push(`complete ${compiledComplete} < naive ${naiveComplete}`);
    return { verdict: "FAIL", manifest, reasons, n, minLlmReduction: minR, tokensEstimated };
  }
  if (skipRateAfter > 0) {
    reasons.push(`compiled skip rate ${skipRateAfter}`);
    return { verdict: "FAIL", manifest, reasons, n, minLlmReduction: minR, tokensEstimated };
  }
  // The ship gate wants honest numbers or absent. Extrapolated island tokens
  // are neither a measurement nor absent — they are an estimate wearing a
  // measurement's clothes — so they do not count: the run must show measured
  // time or measured (non-estimated) token savings.
  const tokensOk = tokensMeasured && !tokensEstimated && tokensSaved != null && tokensSaved > 0;
  const timeOk = timeMeasured && timeSavedMs != null && timeSavedMs > 0;
  if (!tokensOk && !timeOk) {
    reasons.push(
      tokensEstimated
        ? "token savings are extrapolated from remaining LLM calls across the island step, not measured — supply measured time or provider-reported usage"
        : "not measured — quality held but neither tokens nor time saved",
    );
    return { verdict: "INCONCLUSIVE", manifest, reasons, n, minLlmReduction: minR, tokensEstimated };
  }
  return { verdict: "PASS", manifest, reasons, n, minLlmReduction: minR, tokensEstimated };
}

export function canApprove(result: ShadowResult): boolean {
  const m = result.manifest;
  if (result.verdict !== "PASS" || !m) return false;
  if (m.skipRateAfter !== 0) return false;
  const tokensOk = Boolean(m.tokensMeasured) && m.tokensEstimated !== true && (m.tokensSaved ?? 0) > 0;
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
 *
 * When `islandDerived` is proven — see outputDerivesFromIsland() — byte
 * equality is relaxed to structural: an island's prose is fresh every run, so
 * string values are not compared, but object keys must be present and every
 * non-string scalar must be equal after redaction. Unknown references break
 * the chain and fail closed to byte equality.
 */
function outputMatches(actual: unknown, expected: unknown, islandDerived: boolean): boolean | "vacuous" | "prose-divergent" {
  if (expected === undefined) return "vacuous";
  try {
    if (canonicalize(redact(actual)) === canonicalize(redact(expected))) return true;
    if (islandDerived && structurallyEqual(redact(actual), redact(expected))) return "prose-divergent";
    return false;
  } catch {
    return false;
  }
}

/**
 * Structural equality for island-derived output: keys present, non-string
 * scalars equal. Strings are exempt — that is the point; fresh prose is the
 * product — but the shape around them may not drift.
 */
function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => structurallyEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || !ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => structurallyEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  // Strings in matching key positions are accepted as prose divergence — that
  // is the whole relaxation. A string vs a number, or true vs false, still fails.
  if (typeof a === "string" && typeof b === "string") return true;
  return false;
}

/**
 * Does the program's final output derive from an island step?
 *
 * Walks `returns` statically: a binding is proven island-derived when it
 * points (`from`) at a step that is an island, or whose own args/input/over
 * bindings chain back to one. A literal or `input` binding proves nothing;
 * a reference to a step that does not exist breaks the chain, and so does a
 * cycle — both fail closed to plain byte equality in outputMatches().
 */
export function outputDerivesFromIsland(program: StretchProgram): boolean {
  const byId = new Map(program.steps.map((s) => [s.id, s]));

  const bindingsOf = (step: NonNullable<ReturnType<typeof byId.get>>): Binding[] => {
    switch (step.kind) {
      case "tool":
        return Object.values(step.args);
      case "island":
        return [step.input];
      case "loop":
        return [step.over];
      default:
        return []; // assert: reads only
    }
  };

  const bindingProven = (b: Binding, seen: Set<string>): boolean => {
    if (b.kind === "from") return stepProven(b.step, seen);
    if (b.kind === "transform") return bindingProven(b.of, seen);
    return false; // literal or input: no island anywhere upstream
  };

  const stepProven = (id: string, seen: Set<string>): boolean => {
    if (seen.has(id)) return false; // a cycle proves nothing
    const step = byId.get(id);
    if (!step) return false; // unknown reference: fail closed
    if (step.kind === "island") return true;
    const next = new Set(seen).add(id);
    return bindingsOf(step).some((b) => bindingProven(b, next));
  };

  return bindingProven(program.returns, new Set());
}
