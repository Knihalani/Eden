/**
 * Wave 14.3 rotation: a polling world, not a retune of thrash-enforce.
 *
 * Agent waits `get_status` × N (pending→done) then does the work (merge +
 * notify). Bindings use the job id from input, never the poll result, so the
 * mined program is the method — zero poll tool names. Unique-work still
 * refuses: nothing repeating is not a poll to strip.
 *
 *   bun test benchmarks/campaign/poll-world.test.ts
 */

import type { StretchProgram, StretchTrace } from "@eden/ir";
import { compileTraces, isPollName } from "@eden/compile";
import { registryFrom, runProgram } from "@eden/runtime";

/**
 * Pre-registered Wave 14.3 rotation verdict. Recorded before the run.
 * expect: compiled sequence poll-count = 0; unique-work programs = 0.
 * Not thrash-enforce.
 */
export const EXPECT = "poll-world mines a program whose sequence contains zero poll tools; unique-work still refuses.";

export const POLL_TOOL = "get_status";
export const JOB_IDS = ["J-100", "J-101", "J-102", "J-103"] as const;
/** Varying wait lengths so the program cannot be a retuned poll loop width. */
export const POLL_WIDTHS = [4, 5, 6, 5] as const;

export function isPollTool(name: string): boolean {
  return name === POLL_TOOL || isPollName(name);
}

export function pollEvents(jobId: string, pendingN: number): StretchTrace["events"] {
  const pending = Array.from({ length: pendingN }, () => ({
    name: POLL_TOOL,
    args: { id: jobId },
    result: { id: jobId, status: "pending" as const },
    ok: true,
  }));
  return [
    { name: "get_job", args: { id: jobId }, result: { id: jobId, name: `job-${jobId}` }, ok: true },
    ...pending,
    { name: POLL_TOOL, args: { id: jobId }, result: { id: jobId, status: "done" as const }, ok: true },
    { name: "merge", args: { id: jobId }, result: { merged: true, id: jobId }, ok: true },
    { name: "notify", args: { id: jobId }, result: { notified: true, id: jobId }, ok: true },
  ];
}

export function pollTrace(jobId: string, pendingN: number, i: number): StretchTrace {
  const events = pollEvents(jobId, pendingN);
  return {
    id: `poll-${i}`,
    llmCalls: events.length,
    duration_ms: 40 * events.length,
    cost_cents: events.length,
    complete: true,
    input: { id: jobId },
    output: { merged: true, notified: true },
    events,
  };
}

export function pollWorldTraces(): StretchTrace[] {
  return JOB_IDS.map((id, i) => pollTrace(id, POLL_WIDTHS[i] ?? 5, i));
}

export function rawPollCount(traces: StretchTrace[]): number {
  return traces.reduce((n, t) => n + t.events.filter((e) => isPollTool(e.name)).length, 0);
}

export function compiledPollCount(program: StretchProgram): number {
  return (program.sequence ?? []).filter(isPollTool).length;
}

export function minePollWorld(): StretchProgram {
  const traces = pollWorldTraces();
  const { programs, refusals } = compileTraces(traces);
  const p = programs[0];
  if (!p) {
    throw new Error(`poll-world mine produced no program: ${refusals.map((r) => r.reason).join("; ") || "empty"}`);
  }
  return p;
}

/** Unique-work: every stretch a different sequence. Not a poll to strip. */
export function uniqueWorkTraces(n = 5): StretchTrace[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `u${i}`,
    llmCalls: 3,
    duration_ms: 30,
    cost_cents: 3,
    complete: true,
    input: { id: `x${i}` },
    output: { ok: true },
    events: [
      { name: `toolA${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
      { name: `toolB${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
      { name: `toolC${i}`, args: { id: `x${i}` }, result: { ok: true }, ok: true },
    ],
  }));
}

export type PollRunCounts = {
  get_job: number;
  get_status: number;
  merge: number;
  notify: number;
};

/** Replay the mined program. A person runs this: the poll tool must stay at 0. */
export async function runCompiledPollWorld(
  program: StretchProgram,
  input: Record<string, unknown> = { id: JOB_IDS[0] },
): Promise<{ counts: PollRunCounts; value: unknown }> {
  const counts: PollRunCounts = { get_job: 0, get_status: 0, merge: 0, notify: 0 };
  const registry = registryFrom({
    get_job: async (args) => {
      counts.get_job++;
      return { id: args.id, name: `job-${String(args.id)}` };
    },
    get_status: async (args) => {
      counts.get_status++;
      return { id: args.id, status: "pending" };
    },
    merge: async (args) => {
      counts.merge++;
      return { merged: true, id: args.id };
    },
    notify: async (args) => {
      counts.notify++;
      return { notified: true, id: args.id };
    },
  });
  const run = await runProgram(program, input, { registry });
  return { counts, value: run.value };
}
