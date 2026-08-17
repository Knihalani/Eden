import type { Manifest, StretchProgram, StretchTrace, ToolRegistry, IslandCaller } from "@eden/ir";
import { inDistribution, isCheckName, isIslandName, minLlmReductionOf } from "@eden/ir";
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
};

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
      compiledComplete++;
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
