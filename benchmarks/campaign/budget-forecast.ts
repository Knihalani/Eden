/**
 * Wave 15.1 rotation: predicted llm/ms/cents vs remaining budget.
 *
 * Halt is a choice (enforce). Unique-work never takes a budget halt because
 * some other live tool has a large `budget.ms`. Observe never forecast-halts.
 * EDEN_KILL_AFTER_WARNING still wins. Not a retune of unique-work cents.
 *
 *   bun test benchmarks/campaign/budget-forecast.test.ts
 */

import type { StretchProgram } from "@eden/ir";
import type { ForecastView } from "@eden/measure";
import {
  actualSpend,
  createState,
  decideGuard,
  forecastCopy,
  remainingBudget,
  wrapTimeoutMs,
  wrapTools,
  emptyRun,
  type EdenOpts,
  type RunRecorder,
} from "@eden/wrap";

export { forecastCopy };

/**
 * The forecast decideGuard computes for a run: program budget vs actual spend and remaining timeout.
 * Restored from @eden/wrap, which dropped it as unused in c0deff989; this harness is its only caller.
 */
function remainingBudgetForRun(args: {
  program: StretchProgram;
  run: RunRecorder;
  now: number;
  opts: Pick<EdenOpts, "timeoutMs">;
}): ForecastView | null {
  if (!args.program.budget) return null;
  return remainingBudget({
    predicted: args.program.budget,
    actual: actualSpend(args.run, args.now),
    remainingTimeoutMs: wrapTimeoutMs(args.opts.timeoutMs) - (args.now - args.run.t0),
  });
}

/**
 * Pre-registered Wave 15.1 verdict. Recorded before the run.
 * expect: unique-work budget_halt=0; enforce actual≥predicted → halt;
 * observe never forecast-halts; killAfterWarning still wins.
 */
export const EXPECT =
  "forecast halt is predicted vs actual llm/ms/cents; unique-work halt count 0; observe never " +
  "forecast-halts; EDEN_KILL_AFTER_WARNING still wins.";

const liveManifest = {
  llmReduction: 5,
  latencyReduction: 5,
  costReduction: 5,
  skipRateBefore: 0.2,
  skipRateAfter: 0,
  nShadow: 6,
} as StretchProgram["manifest"];

export const PREDICTED = { llmCalls: 2, ms: 80_000, cents: 8 } as const;

const TICKET_HEAD_STEPS = [
  { id: "lookup", kind: "tool" as const, tool: "lookupTicket", args: { id: { kind: "input" as const, path: "id" } } },
  { id: "verify", kind: "tool" as const, tool: "verifyWrite", args: { id: { kind: "input" as const, path: "id" } } },
  { id: "notify", kind: "tool" as const, tool: "notify", args: { id: { kind: "input" as const, path: "id" } } },
];

/** Ticketship-like 3-step program. Wrap's real first-tool path is lookupTicket. */
export function ticketHeadProgram(over: Partial<StretchProgram> = {}): StretchProgram {
  return matchingProgram({
    id: "p_ticket",
    name: "resolve_ticket",
    description: "Lookup, verify, notify.",
    sequence: ["lookupTicket", "verifyWrite", "notify"],
    steps: TICKET_HEAD_STEPS,
    returns: { kind: "from", step: "notify", path: "" },
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    contract: {
      witnesses: 3,
      minLlmReduction: 2,
      allowExact: true,
      envelope: { inputs: { id: ["T-100"] } },
    },
    budget: { ...PREDICTED },
    ...over,
  });
}

const ticketHeadDefs = {
  lookupTicket: async (a: Record<string, unknown>) => ({ ok: true, id: a.id }),
  verifyWrite: async (a: Record<string, unknown>) => ({ verified: true, id: a.id }),
  notify: async (a: Record<string, unknown>) => ({ notified: true, id: a.id }),
};

export type HeadHaltProbe = {
  halted: boolean;
  reason?: string;
  detail?: string;
  served: boolean;
  notified: boolean;
  firstWarningAt: number | undefined;
  keys: string[];
  steps: number;
};

/** Spent halt on the sequence head — wrap's compile-steer path, not a later raw step. */
export async function unwarnedHeadOverBudget(opts: { enforce: boolean }): Promise<HeadHaltProbe> {
  const p = ticketHeadProgram();
  const state = createState({ programs: [p], enforce: opts.enforce, timeoutMs: 60_000 });
  state.run.llmCalls = PREDICTED.llmCalls;
  const firstWarningAt = state.run.firstWarningAt;
  const tools = wrapTools(ticketHeadDefs, state);
  const out = (await tools.lookupTicket.execute({ id: "T-100" })) as {
    eden?: string;
    reason?: string;
    detail?: string;
    notified?: boolean;
    id?: string;
  };
  return {
    halted: out?.eden === "halted",
    reason: out?.reason,
    detail: typeof out?.detail === "string" ? out.detail : undefined,
    served: out?.notified === true,
    notified: out?.notified === true,
    firstWarningAt,
    keys: Object.keys(out ?? {}).sort(),
    steps: p.steps.length,
  };
}

export function matchingProgram(over: Partial<StretchProgram> = {}): StretchProgram {
  return {
    id: "p_issue",
    version: "1",
    name: "issue_bundle",
    description: "",
    inputSchema: { type: "object", properties: {} },
    sequence: ["get_issue", "list_comments"],
    steps: [],
    returns: { kind: "literal", value: null },
    contract: { witnesses: 3, minLlmReduction: 2 },
    manifest: liveManifest,
    budget: { ...PREDICTED },
    ...over,
  } as unknown as StretchProgram;
}

/** A live tool this unique stretch is not on — old guard used max(all budget.ms). */
export function unrelatedHugeProgram(): StretchProgram {
  return matchingProgram({
    id: "p_huge",
    name: "huge_search_write",
    sequence: ["search", "write"],
    budget: { llmCalls: 99, ms: 1_000_000, cents: 99 },
  });
}

export type HaltProbe = {
  budgetHalts: number;
  calls: number;
  reasons: string[];
};

export async function uniqueWorkHaltCount(opts: { enforce: boolean }): Promise<HaltProbe> {
  const unrelated = unrelatedHugeProgram();
  const state = createState({
    programs: [unrelated],
    enforce: opts.enforce,
    timeoutMs: 1_000,
  });
  state.run.firstWarningAt = 0;
  state.run.llmCalls = 9;
  const tools = wrapTools(
    {
      read_alpha: async () => ({ ok: 1 }),
      read_beta: async () => ({ ok: 2 }),
      read_gamma: async () => ({ ok: 3 }),
      read_delta: async () => ({ ok: 4 }),
    },
    state,
  );
  const reasons: string[] = [];
  let calls = 0;
  for (const name of ["read_alpha", "read_beta", "read_gamma", "read_delta"] as const) {
    const out = (await tools[name].execute({})) as { eden?: string; reason?: string; ok?: number };
    calls++;
    if (out?.eden === "halted") reasons.push(out.reason ?? "");
  }
  return {
    budgetHalts: reasons.filter((r) => r === "budget").length,
    calls,
    reasons,
  };
}

export async function enforceOverBudget(): Promise<{
  halted: boolean;
  reason?: string;
  predicted: { llmCalls: number; ms: number; cents: number };
  actual: { llmCalls: number; ms: number; cents: number };
}> {
  const p = matchingProgram();
  const state = createState({ programs: [p], enforce: true, timeoutMs: 60_000 });
  state.run.firstWarningAt = 0;
  state.run.llmCalls = 2;
  state.run.events.push({ name: "get_issue", args: {}, ok: true });
  const tools = wrapTools(
    {
      get_issue: async () => ({ id: 1 }),
      list_comments: async () => ({ n: 0 }),
    },
    state,
  );
  const out = (await tools.list_comments.execute({})) as { eden?: string; reason?: string };
  const view = remainingBudgetForRun({
    program: p,
    run: { ...state.run, llmCalls: 2, firstWarningAt: 0, t0: state.run.t0 },
    now: performance.now(),
    opts: { timeoutMs: 60_000 },
  })!;
  return {
    halted: out?.eden === "halted",
    reason: out?.reason,
    predicted: view.predicted,
    actual: { llmCalls: 2, ms: view.actual.ms, cents: view.actual.cents },
  };
}

export async function observeOverBudget(): Promise<{ halted: boolean; reason?: string; served: boolean }> {
  const p = matchingProgram();
  const state = createState({ programs: [p], enforce: false, timeoutMs: 60_000 });
  state.run.firstWarningAt = 0;
  state.run.llmCalls = 2;
  state.run.events.push({ name: "get_issue", args: {}, ok: true });
  const tools = wrapTools({ list_comments: async () => ({ n: 0 }) }, state);
  const out = (await tools.list_comments.execute({})) as { eden?: string; reason?: string; n?: number };
  return {
    halted: out?.eden === "halted",
    reason: out?.reason,
    served: out?.n === 0,
  };
}

/** Spent (actual ≥ predicted) must halt even with firstWarningAt unset. */
export async function unwarnedOverBudget(opts: { enforce: boolean }): Promise<{
  halted: boolean;
  reason?: string;
  served: boolean;
  firstWarningAt: number | undefined;
  detail: string;
  predicted: { llmCalls: number; ms: number; cents: number };
  actualLlm: number;
}> {
  const p = matchingProgram();
  const run = emptyRun();
  run.llmCalls = 2;
  run.t0 = 0;
  run.events.push({ name: "get_issue", args: {}, ok: true });
  const d = decideGuard({
    name: "list_comments",
    run,
    live: [p],
    opts: { enforce: opts.enforce, timeoutMs: 60_000 },
    now: 1_000,
  });
  const state = createState({ programs: [p], enforce: opts.enforce, timeoutMs: 60_000 });
  state.run.llmCalls = 2;
  state.run.events.push({ name: "get_issue", args: {}, ok: true });
  const firstWarningAt = state.run.firstWarningAt;
  const tools = wrapTools(
    {
      get_issue: async () => ({ id: 1 }),
      list_comments: async () => ({ n: 0 }),
    },
    state,
  );
  const out = (await tools.list_comments.execute({})) as { eden?: string; reason?: string; n?: number };
  return {
    halted: out?.eden === "halted",
    reason: out?.reason,
    served: out?.n === 0,
    firstWarningAt,
    detail: d && "detail" in d ? (d.detail ?? "") : "",
    predicted: { ...PREDICTED },
    actualLlm: 2,
  };
}

export async function uniqueWorkUnwarnedHaltCount(): Promise<HaltProbe> {
  const unrelated = unrelatedHugeProgram();
  const state = createState({
    programs: [unrelated],
    enforce: true,
    timeoutMs: 1_000,
  });
  state.run.llmCalls = 9;
  const tools = wrapTools(
    {
      read_alpha: async () => ({ ok: 1 }),
      read_beta: async () => ({ ok: 2 }),
      read_gamma: async () => ({ ok: 3 }),
      read_delta: async () => ({ ok: 4 }),
    },
    state,
  );
  const reasons: string[] = [];
  let calls = 0;
  for (const name of ["read_alpha", "read_beta", "read_gamma", "read_delta"] as const) {
    const out = (await tools[name].execute({})) as { eden?: string; reason?: string };
    calls++;
    if (out?.eden === "halted") reasons.push(out.reason ?? "");
  }
  return {
    budgetHalts: reasons.filter((r) => r === "budget").length,
    calls,
    reasons,
  };
}

export function killAfterWarningDecision(): { reason: string; budgetWouldHalt: boolean } {
  const p = matchingProgram({ budget: { llmCalls: 8, ms: 5_000, cents: 8 } });
  const run = emptyRun();
  run.firstWarningAt = 0;
  run.t0 = 0;
  run.events.push({ name: "get_issue", args: {}, ok: true });
  const opts: EdenOpts = { killAfterWarning: true, enforce: true, timeoutMs: 60_000 };
  const d = decideGuard({ name: "list_comments", run, live: [p], opts, now: 1_000 });
  const view = remainingBudgetForRun({ program: p, run, now: 1_000, opts })!;
  return { reason: d?.reason ?? "", budgetWouldHalt: view.halt };
}

export function timeoutPressureHalt(): { action: string; reason: string } {
  const tooBig = matchingProgram({
    id: "p_big",
    budget: { llmCalls: 8, ms: 120_000, cents: 8 },
  });
  const run = emptyRun();
  run.firstWarningAt = 0;
  run.t0 = 0;
  run.events.push({ name: "get_issue", args: {}, ok: true });
  const d = decideGuard({
    name: "list_comments",
    run,
    live: [tooBig],
    opts: { timeoutMs: 60_000 },
    now: 10_000,
  });
  return { action: d?.action ?? "none", reason: d && "reason" in d ? d.reason : "" };
}

export function predictedVsActualPrint(predicted = PREDICTED, actualLlm = 2) {
  return remainingBudget({
    predicted,
    actual: { llmCalls: actualLlm, ms: 40, cents: 3 },
    remainingTimeoutMs: 50_000,
  });
}
