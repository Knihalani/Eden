/**
 * Wave 14.4 rotation: CI-gate fork mining with the same honesty gates as linear.
 * Not a retune of thrash-enforce.
 *
 * A person runs `bun test benchmarks/campaign/fork-gate.test.ts` and reads
 * compile output: one branched program on the happy path; named refusals
 * (too_short / empty_output / underdetermined_write / max_programs) otherwise.
 *
 * Pre-registered expect (ROADMAP §4.9) is `EXPECT` below.
 */

import type { StretchProgram, StretchTrace } from "@eden/ir";
import { compileTraces, type CompileResult } from "@eden/compile";

/**
 * Pre-registered Wave 14.4 rotation verdict. Recorded before the run.
 * expect: CI-gate mines one branched program; min-3 / empty / unbound write /
 * MAX_PROGRAMS overflow are named refusals. Not thrash-enforce.
 */
export const EXPECT =
  "CI-gate mines 1 branched program; min-3 per arm, empty output, unbound mutating write (underdetermined_write), and 25th program is max_programs — not a silent drop.";

export const MAX_PROGRAMS = 24;

function ciTrace(
  id: string,
  state: string,
  tail: string[],
  pr: number,
  output: unknown = { done: true },
): StretchTrace {
  return {
    id,
    events: [
      { name: "get_ci", args: { pr }, result: { state, pr }, ok: true },
      ...tail.map((name) => ({ name, args: { pr }, result: { done: true, pr }, ok: true })),
    ],
    input: { pr },
    output,
    llmCalls: 4,
    duration_ms: 4000,
    cost_cents: 4,
    complete: true,
  };
}

/** Failure→fix vs success→notify. Three witnesses per arm. */
export function ciGateTraces(): StretchTrace[] {
  return [
    ciTrace("t1", "failure", ["fix_build", "notify"], 101),
    ciTrace("t2", "failure", ["fix_build", "notify"], 102),
    ciTrace("t3", "failure", ["fix_build", "notify"], 103),
    ciTrace("t4", "success", ["notify"], 201),
    ciTrace("t5", "success", ["notify"], 202),
    ciTrace("t6", "success", ["notify"], 203),
  ];
}

/** Two witnesses on the failing arm — below min-3. */
export function shortArmTraces(): StretchTrace[] {
  return [
    ciTrace("t1", "failure", ["fix_build", "notify"], 101),
    ciTrace("t2", "failure", ["fix_build", "notify"], 102),
    ciTrace("t4", "success", ["notify"], 201),
    ciTrace("t5", "success", ["notify"], 202),
    ciTrace("t6", "success", ["notify"], 203),
  ];
}

/** Same CI-gate shape; every witness returns empty output. */
export function emptyOutputTraces(): StretchTrace[] {
  return ciGateTraces().map((t) => ({ ...t, output: {} }));
}

/**
 * Then-arm writeRecord.id varies and is not the stretch input — mutating
 * unbound, must refuse rather than guess OTHER-*.
 */
export function unboundWriteArmTraces(): StretchTrace[] {
  return [
    ...[101, 102, 103].map((pr, i) => ({
      id: `fail-${i}`,
      events: [
        { name: "get_ci", args: { pr }, result: { state: "failure", pr }, ok: true },
        { name: "writeRecord", args: { id: `OTHER-${pr}` }, result: { wrote: true }, ok: true },
        { name: "notify", args: { pr }, result: { done: true, pr }, ok: true },
      ],
      input: { pr },
      output: { done: true },
      llmCalls: 4,
      duration_ms: 4000,
      cost_cents: 4,
      complete: true,
    })),
    ...[201, 202, 203].map((pr, i) => ({
      id: `ok-${i}`,
      events: [
        { name: "get_ci", args: { pr }, result: { state: "success", pr }, ok: true },
        { name: "merge_pr", args: { pr }, result: { done: true, pr }, ok: true },
        { name: "notify", args: { pr }, result: { done: true, pr }, ok: true },
      ],
      input: { pr },
      output: { done: true },
      llmCalls: 4,
      duration_ms: 4000,
      cost_cents: 4,
      complete: true,
    })),
  ];
}

function linearCluster(k: number): StretchTrace[] {
  return Array.from({ length: 3 }, (_, i) => {
    const id = `C${k}-${i}`;
    return {
      id: `lin-${k}-${i}`,
      events: [
        { name: `getCluster${k}`, args: { id }, result: { id, ok: true }, ok: true },
        { name: `writeCluster${k}`, args: { id }, result: { wrote: true, id }, ok: true },
        { name: `notifyCluster${k}`, args: { id }, result: { done: true, id }, ok: true },
      ],
      input: { id },
      output: { done: true, k, i },
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
    };
  });
}

/** 24 distinct linear stretches plus one CI-gate fork — one over the cap. */
export function overflowSoup(): StretchTrace[] {
  const traces: StretchTrace[] = [];
  for (let k = 0; k < MAX_PROGRAMS; k++) traces.push(...linearCluster(k));
  traces.push(...ciGateTraces());
  return traces;
}

export function compileCiGate(): CompileResult {
  return compileTraces(ciGateTraces());
}

export function branchedPrograms(result: CompileResult): StretchProgram[] {
  return result.programs.filter((p) => p.steps?.some((s) => s.kind === "branch"));
}

export function forkInSoup(result: CompileResult): boolean {
  if (branchedPrograms(result).length > 0) return true;
  return result.refusals.some((r) => r.sequence.some((s) => s.startsWith("branch_")));
}
