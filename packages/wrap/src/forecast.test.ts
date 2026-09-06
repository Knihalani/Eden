import { describe, expect, test } from "bun:test";
import type { StretchProgram } from "@eden/ir";
import {
  actualSpend,
  forecastHalt,
  inFlightProgram,
  isUniqueWork,
  matchingRunPrograms,
  remainingBudget,
  remainingBudgetForRun,
  forecastCopy,
} from "./forecast";
import { decideGuard, killAfterWarningEnabled } from "./guard";
import { createState, wrapTools } from "./wrap-tools";
import { emptyRun, type EdenOpts } from "./types";

function manifestOf(name: string): StretchProgram["manifest"] {
  return {
    name,
    llmReduction: 5,
    latencyReduction: 5,
    costReduction: 5,
    skipRateBefore: 0.2,
    skipRateAfter: 0,
    nShadow: 6,
  } as unknown as StretchProgram["manifest"];
}

function program(over: Partial<StretchProgram> = {}): StretchProgram {
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
    manifest: manifestOf("issue_bundle"),
    budget: { llmCalls: 2, ms: 80_000, cents: 8 },
    ...over,
  } as unknown as StretchProgram;
}

/** Ticketship-like 3-step live program. Head is lookupTicket — wrap's real first-tool path. */
function ticketHeadProgram(over: Partial<StretchProgram> = {}): StretchProgram {
  return program({
    id: "p_ticket",
    name: "resolve_ticket",
    description: "Lookup, verify, notify.",
    sequence: ["lookupTicket", "verifyWrite", "notify"],
    steps: [
      { id: "lookup", kind: "tool", tool: "lookupTicket", args: { id: { kind: "input", path: "id" } } },
      { id: "verify", kind: "tool", tool: "verifyWrite", args: { id: { kind: "input", path: "id" } } },
      { id: "notify", kind: "tool", tool: "notify", args: { id: { kind: "input", path: "id" } } },
    ],
    returns: { kind: "from", step: "notify", path: "" },
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    contract: {
      witnesses: 3,
      minLlmReduction: 2,
      allowExact: true,
      envelope: { inputs: { id: ["T-100"] } },
    },
    budget: { llmCalls: 2, ms: 80_000, cents: 8 },
    ...over,
  });
}

const ticketHeadDefs = {
  lookupTicket: async (a: Record<string, unknown>) => ({ ok: true, id: a.id }),
  verifyWrite: async (a: Record<string, unknown>) => ({ verified: true, id: a.id }),
  notify: async (a: Record<string, unknown>) => ({ notified: true, id: a.id }),
};

function warnedRun(over: Partial<{ llmCalls: number; cost: number; t0: number; events: string[] }> = {}) {
  const run = emptyRun();
  run.firstWarningAt = 0;
  run.llmCalls = over.llmCalls ?? 0;
  run.cost = over.cost ?? 0;
  run.t0 = over.t0 ?? 0;
  for (const name of over.events ?? ["get_issue"]) {
    run.events.push({ name, args: {}, ok: true });
  }
  return run;
}

describe("matchingRunPrograms (the program this run is on)", () => {
  test("picks the in-flight sequence, not the union of live tools", () => {
    const on = program({ id: "on", sequence: ["get_issue", "list_comments"] });
    const other = program({
      id: "other",
      sequence: ["search", "write"],
      budget: { llmCalls: 99, ms: 1_000_000, cents: 99 },
    });
    const hits = matchingRunPrograms([other, on], [{ name: "get_issue" }, { name: "list_comments" }]);
    expect(hits.map((p) => p.id)).toEqual(["on"]);
    expect(inFlightProgram([other, on], [{ name: "get_issue" }])?.id).toBe("on");
    expect(isUniqueWork([other], [{ name: "alpha" }, { name: "beta" }])).toBe(true);
  });
});

describe("unique-work is never budget-halted", () => {
  test("programs: [] — halt count 0 for reason budget", () => {
    const run = warnedRun({ events: ["alpha"], llmCalls: 9, t0: 0 });
    const d = decideGuard({
      name: "beta",
      run,
      live: [],
      opts: { enforce: true, timeoutMs: 1_000 },
      now: 900,
    });
    expect(d).toBeNull();
  });

  test("no matching sequence + huge unrelated live budget.ms → halt count 0", async () => {
    const unrelated = program({
      id: "p_huge",
      name: "huge_search_write",
      sequence: ["search", "write"],
      budget: { llmCalls: 99, ms: 1_000_000, cents: 99 },
    });
    const run = warnedRun({ events: ["read_alpha"], llmCalls: 9, cost: 50, t0: 0 });
    const d = decideGuard({
      name: "read_beta",
      run,
      live: [unrelated],
      opts: { enforce: true, timeoutMs: 1_000 },
      now: 900,
    });
    expect(d).toBeNull();
    expect(d?.reason === "budget" ? 1 : 0).toBe(0);

    const state = createState({ programs: [unrelated], enforce: true, timeoutMs: 1_000 });
    state.run.firstWarningAt = 0;
    state.run.llmCalls = 9;
    state.run.cost = 50;
    const tools = wrapTools(
      {
        read_alpha: async () => ({ ok: 1 }),
        read_beta: async () => ({ ok: 2 }),
        read_gamma: async () => ({ ok: 3 }),
        read_delta: async () => ({ ok: 4 }),
      },
      state,
    );
    let budgetHalts = 0;
    for (const name of ["read_alpha", "read_beta", "read_gamma", "read_delta"] as const) {
      const out = (await tools[name].execute({})) as { eden?: string; reason?: string };
      if (out?.eden === "halted" && out.reason === "budget") budgetHalts++;
    }
    console.log(`unique-work budget_halt=${budgetHalts} unrelated_predicted_ms=${unrelated.budget!.ms}`);
    expect(budgetHalts).toBe(0);
  });
});

describe("predicted vs actual (llm / ms / cents)", () => {
  test("enforce: actual llmCalls >= predicted llmCalls=2 → next call halted reason budget", async () => {
    const p = program({ budget: { llmCalls: 2, ms: 80_000, cents: 8 } });
    const run = warnedRun({ llmCalls: 2, events: ["get_issue"], t0: 0 });
    const view = remainingBudgetForRun({ program: p, run, now: 1_000, opts: { timeoutMs: 60_000 } })!;
    console.log(
      `predicted llmCalls=${view.predicted.llmCalls} ms=${view.predicted.ms} cents=${view.predicted.cents} ` +
        `actual llmCalls=${view.actual.llmCalls} ms=${view.actual.ms} cents=${view.actual.cents} ` +
        `overflow=${view.overflow} halt=${view.halt}`,
    );
    expect(view.predicted).toEqual({ llmCalls: 2, ms: 80_000, cents: 8 });
    expect(view.actual.llmCalls).toBeGreaterThanOrEqual(view.predicted.llmCalls);
    expect(view.overflow).toBe("llmCalls");
    expect(forecastHalt({
      predicted: view.predicted,
      actual: view.actual,
      remainingTimeoutMs: view.remainingTimeoutMs,
    })).toBe(true);

    const d = decideGuard({
      name: "list_comments",
      run,
      live: [p],
      opts: { enforce: true, timeoutMs: 60_000 },
      now: 1_000,
    });
    expect(d).toMatchObject({ action: "halt", reason: "budget" });

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
    // Tail path (list_comments is not sequence[0]). Head compile-steer is the
    // test below — wrap's real first-tool path.
    const out = (await tools.list_comments.execute({})) as { eden?: string; reason?: string; detail?: string };
    expect(out).toEqual({ eden: "halted", reason: "budget", detail: "predicted llmCalls=2 actual=2" });
    // emit() on halt resets the recorder; the comparison used llmCalls=2.
  });

  test("unwarned: firstWarningAt undefined, actual llmCalls>=predicted → enforce halt, observe served", async () => {
    const p = program({ budget: { llmCalls: 2, ms: 80_000, cents: 8 } });
    const run = emptyRun();
    run.llmCalls = 2;
    run.t0 = 0;
    run.events.push({ name: "get_issue", args: {}, ok: true });
    expect(run.firstWarningAt).toBeUndefined();

    const d = decideGuard({
      name: "list_comments",
      run,
      live: [p],
      opts: { enforce: true, timeoutMs: 60_000 },
      now: 1_000,
    });
    console.log(
      `unwarned halt=${d?.action === "halt"} reason=${d?.reason ?? "none"} ` +
        `detail=${d && "detail" in d ? d.detail : ""} firstWarningAt=${run.firstWarningAt ?? "undefined"}`,
    );
    expect(d).toMatchObject({ action: "halt", reason: "budget" });
    expect(d && "detail" in d ? d.detail : "").toBe("predicted llmCalls=2 actual=2");
    expect(forecastCopy(remainingBudget({
      predicted: p.budget!,
      actual: { llmCalls: 2, ms: 1_000, cents: 0 },
      remainingTimeoutMs: 59_000,
    }))).toBe("predicted llmCalls=2 actual=2");

    const enforced = createState({ programs: [p], enforce: true, timeoutMs: 60_000 });
    expect(enforced.run.firstWarningAt).toBeUndefined();
    enforced.run.llmCalls = 2;
    enforced.run.events.push({ name: "get_issue", args: {}, ok: true });
    const haltTools = wrapTools(
      {
        get_issue: async () => ({ id: 1 }),
        list_comments: async () => ({ n: 0 }),
      },
      enforced,
    );
    const halted = (await haltTools.list_comments.execute({})) as { eden?: string; reason?: string; detail?: string };
    expect(halted).toEqual({ eden: "halted", reason: "budget", detail: "predicted llmCalls=2 actual=2" });

    const observed = createState({ programs: [p], enforce: false, timeoutMs: 60_000 });
    expect(observed.run.firstWarningAt).toBeUndefined();
    observed.run.llmCalls = 2;
    observed.run.events.push({ name: "get_issue", args: {}, ok: true });
    const serveTools = wrapTools({ list_comments: async () => ({ n: 0 }) }, observed);
    const served = (await serveTools.list_comments.execute({})) as { n?: number; eden?: string };
    console.log(`unwarned observe eden=${served.eden ?? "none"} served=${served.n === 0}`);
    expect(served.eden).toBeUndefined();
    expect(served.n).toBe(0);
  });

  test("sequence-head spent halt: enforce returns halt+detail, observe compiles", async () => {
    const p = ticketHeadProgram();
    expect(p.steps.length).toBe(3);
    expect((p.sequence ?? [])[0]).toBe("lookupTicket");

    const enforced = createState({ programs: [p], enforce: true, timeoutMs: 60_000 });
    expect(enforced.run.firstWarningAt).toBeUndefined();
    enforced.run.llmCalls = 2;
    const haltTools = wrapTools(ticketHeadDefs, enforced);
    const halted = (await haltTools.lookupTicket.execute({ id: "T-100" })) as {
      eden?: string;
      reason?: string;
      detail?: string;
      notified?: boolean;
    };
    console.log(
      `head enforce eden=${halted.eden} reason=${halted.reason} detail=${halted.detail ?? ""} ` +
        `notified=${halted.notified === true} keys=${Object.keys(halted).sort().join(",")}`,
    );
    expect(halted).toEqual({
      eden: "halted",
      reason: "budget",
      detail: "predicted llmCalls=2 actual=2",
    });
    expect(halted.notified).toBeUndefined();

    const observed = createState({ programs: [p], enforce: false, timeoutMs: 60_000 });
    expect(observed.run.firstWarningAt).toBeUndefined();
    observed.run.llmCalls = 2;
    const serveTools = wrapTools(ticketHeadDefs, observed);
    const served = (await serveTools.lookupTicket.execute({ id: "T-100" })) as {
      eden?: string;
      notified?: boolean;
      id?: string;
    };
    console.log(`head observe eden=${served.eden ?? "none"} notified=${served.notified === true}`);
    expect(served.eden).toBeUndefined();
    expect(served).toEqual({ notified: true, id: "T-100" });
  });

  test("unwarned unique-work still budget_halt=0", async () => {
    const unrelated = program({
      id: "p_huge",
      name: "huge_search_write",
      sequence: ["search", "write"],
      budget: { llmCalls: 99, ms: 1_000_000, cents: 99 },
    });
    const run = emptyRun();
    run.llmCalls = 9;
    run.cost = 50;
    run.t0 = 0;
    run.events.push({ name: "read_alpha", args: {}, ok: true });
    expect(run.firstWarningAt).toBeUndefined();
    const d = decideGuard({
      name: "read_beta",
      run,
      live: [unrelated],
      opts: { enforce: true, timeoutMs: 1_000 },
      now: 900,
    });
    expect(d).toBeNull();

    const state = createState({ programs: [unrelated], enforce: true, timeoutMs: 1_000 });
    expect(state.run.firstWarningAt).toBeUndefined();
    state.run.llmCalls = 9;
    state.run.cost = 50;
    const tools = wrapTools(
      {
        read_alpha: async () => ({ ok: 1 }),
        read_beta: async () => ({ ok: 2 }),
        read_gamma: async () => ({ ok: 3 }),
        read_delta: async () => ({ ok: 4 }),
      },
      state,
    );
    let budgetHalts = 0;
    for (const name of ["read_alpha", "read_beta", "read_gamma", "read_delta"] as const) {
      const out = (await tools[name].execute({})) as { eden?: string; reason?: string };
      if (out?.eden === "halted" && out.reason === "budget") budgetHalts++;
    }
    console.log(`unwarned unique-work budget_halt=${budgetHalts}`);
    expect(budgetHalts).toBe(0);
  });

  test("unwarned timeout-pressure does not halt (stays behind firstWarningAt)", () => {
    const tooBig = program({
      id: "p_big",
      budget: { llmCalls: 8, ms: 120_000, cents: 8 },
    });
    const run = emptyRun();
    run.t0 = 0;
    run.events.push({ name: "get_issue", args: {}, ok: true });
    expect(run.firstWarningAt).toBeUndefined();
    const d = decideGuard({
      name: "list_comments",
      run,
      live: [tooBig],
      opts: { timeoutMs: 60_000 },
      now: 10_000,
    });
    expect(d).toBeNull();
  });

  test("observe: same actual >= predicted does not halt", async () => {
    const p = program({ budget: { llmCalls: 2, ms: 80_000, cents: 8 } });
    const run = warnedRun({ llmCalls: 2, events: ["get_issue"], t0: 0 });
    // decideGuard still *returns* halt (the choice lives at wrap); wrap ignores it.
    const d = decideGuard({
      name: "list_comments",
      run,
      live: [p],
      opts: { enforce: false, timeoutMs: 60_000 },
      now: 1_000,
    });
    expect(d).toMatchObject({ action: "halt", reason: "budget" });

    const state = createState({ programs: [p], enforce: false, timeoutMs: 60_000 });
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
    const out = (await tools.list_comments.execute({})) as { n?: number; eden?: string };
    expect(out.eden).toBeUndefined();
    expect(out.n).toBe(0);
  });

  test("default (no enforce) wrapTools never forecast-halts", async () => {
    const p = program({ budget: { llmCalls: 2, ms: 80_000, cents: 8 } });
    const state = createState({ programs: [p], timeoutMs: 60_000 });
    expect(state.opts.enforce).toBeUndefined();
    state.run.firstWarningAt = 0;
    state.run.llmCalls = 2;
    state.run.events.push({ name: "get_issue", args: {}, ok: true });
    const tools = wrapTools({ list_comments: async () => ({ n: 0 }) }, state);
    const out = (await tools.list_comments.execute({})) as { n?: number; eden?: string };
    expect(out.eden).toBeUndefined();
    expect(out.n).toBe(0);
  });

  test("actual cents >= predicted cents halts under decideGuard", () => {
    const p = program({ budget: { llmCalls: 8, ms: 80_000, cents: 4 } });
    const run = warnedRun({ llmCalls: 1, cost: 4, events: ["get_issue"], t0: 0 });
    const d = decideGuard({
      name: "list_comments",
      run,
      live: [p],
      opts: { timeoutMs: 60_000 },
      now: 1_000,
    });
    expect(d).toMatchObject({ action: "halt", reason: "budget" });
    const view = remainingBudget({
      predicted: p.budget!,
      actual: actualSpend(run, 1_000),
      remainingTimeoutMs: 59_000,
    });
    expect(view.overflow).toBe("cents");
    expect(view.actual.cents).toBeGreaterThanOrEqual(view.predicted.cents);
  });

  test("actual elapsed ms >= predicted ms halts", () => {
    const p = program({ budget: { llmCalls: 8, ms: 100, cents: 8 } });
    const run = warnedRun({ llmCalls: 1, events: ["get_issue"], t0: 0 });
    const d = decideGuard({
      name: "list_comments",
      run,
      live: [p],
      opts: { timeoutMs: 60_000 },
      now: 100,
    });
    expect(d).toMatchObject({ action: "halt", reason: "budget" });
  });
});

describe("predicted ms vs remaining timeout (matching program only)", () => {
  test("predicted ms > remaining timeout still halts when nothing on-path fits", () => {
    const tooBig = program({
      id: "p_big",
      budget: { llmCalls: 8, ms: 120_000, cents: 8 },
    });
    const run = warnedRun({ events: ["get_issue"], t0: 0 });
    const d = decideGuard({
      name: "list_comments",
      run,
      live: [tooBig],
      opts: { timeoutMs: 60_000 },
      now: 10_000,
    });
    expect(d).toMatchObject({ action: "halt", reason: "budget" });
  });

  test("steers to an on-path program that fits remaining timeout", () => {
    const tooBig = program({
      id: "p_big",
      name: "big_bundle",
      budget: { llmCalls: 8, ms: 120_000, cents: 8 },
      manifest: manifestOf("big_bundle"),
    });
    const fits = program({
      id: "p_small",
      name: "small_bundle",
      budget: { llmCalls: 8, ms: 5_000, cents: 8 },
      manifest: manifestOf("small_bundle"),
    });
    const run = warnedRun({ events: ["get_issue"], t0: 0 });
    const d = decideGuard({
      name: "list_comments",
      run,
      live: [tooBig, fits],
      opts: { timeoutMs: 60_000 },
      now: 10_000,
    });
    expect(d).toMatchObject({ action: "steer", reason: "budget", program: fits });
  });

  test("a huge unrelated live budget.ms does not create timeout pressure for this run", () => {
    const on = program({ budget: { llmCalls: 4, ms: 5_000, cents: 8 } });
    const unrelated = program({
      id: "p_unrelated",
      sequence: ["search", "write"],
      budget: { llmCalls: 99, ms: 1_000_000, cents: 99 },
    });
    const run = warnedRun({ events: ["get_issue"], t0: 0, llmCalls: 1 });
    const d = decideGuard({
      name: "list_comments",
      run,
      live: [unrelated, on],
      opts: { timeoutMs: 60_000 },
      now: 2_000,
    });
    expect(d).toBeNull();
  });
});

describe("EDEN_KILL_AFTER_WARNING still wins", () => {
  test("killAfterWarning halts with reason warning even when predicted budget would fit", () => {
    const p = program({ budget: { llmCalls: 8, ms: 5_000, cents: 8 } });
    const run = warnedRun({ llmCalls: 0, events: ["get_issue"], t0: 0 });
    const opts: EdenOpts = { killAfterWarning: true, enforce: true, timeoutMs: 60_000 };
    expect(killAfterWarningEnabled(opts)).toBe(true);
    const d = decideGuard({
      name: "list_comments",
      run,
      live: [p],
      opts,
      now: 1_000,
    });
    expect(d).toMatchObject({ action: "halt", reason: "warning" });
    const view = remainingBudgetForRun({ program: p, run, now: 1_000, opts })!;
    expect(view.timeoutPressure).toBe(false);
    expect(view.spent).toBe(false);
    expect(view.halt).toBe(false);
  });

  test("wrapTools killAfterWarning still stops spend after the first fail", async () => {
    const p = program({ budget: { llmCalls: 8, ms: 80_000, cents: 8 } });
    const state = createState({ programs: [p], killAfterWarning: true, enforce: true });
    const tools = wrapTools(
      {
        boom: async () => {
          throw new Error("no");
        },
      },
      state,
    );
    await expect(tools.boom.execute({})).rejects.toThrow("no");
    expect(await tools.boom.execute({})).toEqual({ eden: "halted", reason: "warning" });
  });
});
