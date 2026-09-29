/**
 * Helix campaign CI: new domains (not a retune). compileTraces + runProgram
 * + check(), unique-work empty, goLive PASS on launch / offset / barcode.
 * goLive failure is FAIL, not skip-as-win.
 */
import { describe, expect, test } from "bun:test";
import { compileTraces } from "@eden/compile";
import { mulberry32 } from "@eden/measure";
import type { StretchTrace } from "@eden/ir";
import { registryFrom, runProgram } from "@eden/runtime";
import { type CallResult, type World, blockSeed } from "./worlds";
import { Session } from "./session";
import {
  BATCHES,
  IMAGE_TAGS,
  INBOXES,
  LAUNCH_STEPS,
  NOISE_IDS,
  PAGE_SIZE,
  PAGES,
  PROJECTS,
  QUEUES,
  SITES,
  TREES,
  WAVES,
  createBarcodeLots,
  createDedupeMail,
  createFsTree,
  createGitlabOffset,
  createHelixNoise,
  createLaunchPad,
  createLedgerSettle,
  createPrioQueue,
  createRateLimitRetry,
  gitlabIssues,
  jobsByPrio,
  ledgerTotal,
  lotsFor,
  treeLeaves,
  treeFor,
  uniqueAddrs,
} from "./helix-worlds";

process.env.CAMPAIGN_THINK_MS = "0";
const TIMEOUT = 8_000;

async function recordStretch(world: World, goal: Record<string, unknown>, seed: number): Promise<StretchTrace> {
  const tools = world.tools();
  world.beginStretch?.();
  const gen = world.script(goal, mulberry32(seed >>> 0));
  const events: StretchTrace["events"] = [];
  let sent: CallResult | undefined;
  let lastValue: unknown;
  for (;;) {
    const next = await gen.next(sent as never);
    if (next.done) break;
    const { tool, args } = next.value;
    let out: CallResult;
    try {
      const v = await tools[tool]!.execute(args);
      out = { ok: true, value: v };
      lastValue = v;
    } catch (err) {
      out = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    events.push({ name: tool, args, result: out.ok ? out.value : { error: out.error }, ok: out.ok });
    sent = out;
    if (out.ok && world.done(out.value)) break;
  }
  return {
    id: `${world.name}-${seed}`,
    events,
    input: goal,
    output: lastValue,
    llmCalls: events.filter((e) => e.ok).length,
    duration_ms: 1,
    cost_cents: events.filter((e) => e.ok).length,
    skipped: [],
    complete: true,
  };
}

async function recordN(factory: () => World, goals: Array<Record<string, unknown>>, n = 4): Promise<StretchTrace[]> {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < n; i++) traces.push(await recordStretch(factory(), goals[i % goals.length]!, 400 + i));
  return traces;
}

describe("helix compile + runProgram", () => {
  test("launch-pad: 12-step linear; runProgram publishes once", async () => {
    const goals = SITES.map((s) => ({ site: s.site, env: s.env }));
    const traces = await recordN(createLaunchPad, goals);
    expect(traces[0]!.events.filter((e) => e.ok).map((e) => e.name)).toEqual([...LAUNCH_STEPS]);
    const { programs, refusals } = compileTraces(traces);
    const p = programs[0];
    expect(p, `launch: ${refusals.map((r) => r.reason).join("|")}`).toBeTruthy();
    expect(p!.sequence?.length ?? p!.steps.filter((s) => s.kind === "tool").length).toBeGreaterThanOrEqual(12);
    const w = createLaunchPad();
    await runProgram(p!, goals[0]!, { registry: registryFrom(w.tools()), checkEnvelope: false });
    expect(w.check([goals[0]!])).toEqual([]);
  });

  test("gitlab offset: page/limit walk then foreach; not a cursor nextCursor", async () => {
    const goals = [...PROJECTS].map((project) => ({ project }));
    const traces = await recordN(createGitlabOffset, goals);
    const pages = traces[0]!.events.filter((e) => e.name === "listIssues");
    expect(pages).toHaveLength(PAGES);
    expect(pages.every((e) => typeof (e.args as { page?: unknown }).page === "number")).toBe(true);
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "unbound_foreach")).toEqual([]);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "loop"));
    expect(p, `offset: ${refusals.map((r) => r.reason).join("|")}`).toBeTruthy();
    const w = createGitlabOffset();
    await runProgram(p!, { project: "gl-0" }, { registry: registryFrom(w.tools()), checkEnvelope: false });
    expect(w.check([{ project: "gl-0" }])).toEqual([]);
    expect(gitlabIssues("gl-0")).toHaveLength(PAGE_SIZE * PAGES);
  });

  test("retry / tree / unique / sort / reduce / barcode compile; noise is empty", async () => {
    const cases: Array<{ name: string; factory: () => World; goals: Array<Record<string, unknown>>; wantLoop?: boolean }> = [
      { name: "retry", factory: createRateLimitRetry, goals: [...IMAGE_TAGS].map((tag) => ({ tag })) },
      { name: "tree", factory: createFsTree, goals: [...TREES].map((tree) => ({ tree })), wantLoop: true },
      { name: "unique", factory: createDedupeMail, goals: [...INBOXES].map((inbox) => ({ inbox })), wantLoop: true },
      { name: "sort", factory: createPrioQueue, goals: [...QUEUES].map((queue) => ({ queue })), wantLoop: true },
      { name: "reduce", factory: createLedgerSettle, goals: [...BATCHES].map((batch) => ({ batch })), wantLoop: true },
      { name: "barcode", factory: createBarcodeLots, goals: [...WAVES].map((wave) => ({ wave })), wantLoop: true },
    ];
    for (const c of cases) {
      const traces = await recordN(c.factory, c.goals);
      const { programs, refusals } = compileTraces(traces);
      const p = programs[0];
      expect(p, `${c.name}: ${refusals.map((r) => r.reason).join("|")}`).toBeTruthy();
      if (c.wantLoop) expect(p!.steps.some((s) => s.kind === "loop"), `${c.name} loop`).toBe(true);
      const w = c.factory();
      w.beginStretch?.();
      await runProgram(p!, c.goals[0]!, { registry: registryFrom(w.tools()), checkEnvelope: false });
      expect(w.check([c.goals[0]!]), `${c.name} check`).toEqual([]);
    }
    const noise = await recordN(createHelixNoise, [...NOISE_IDS].map((id) => ({ id })));
    const empty = compileTraces(noise);
    expect(empty.programs).toEqual([]);
  });

  test("sort walks descending prio; unique is first-seen addrs; reduce settles the sum", () => {
    expect(jobsByPrio("q-0").map((j) => j.id)).toEqual(["q-0-a", "q-0-b", "q-0-c"]);
    expect(uniqueAddrs("ib-0")).toEqual(["ib-0-a@ex.test", "ib-0-b@ex.test", "ib-0-c@ex.test"]);
    expect(ledgerTotal("bat-0")).toBe(40);
    expect(treeLeaves(treeFor("tree-0"))).toEqual(["tree-0/a/f0.txt", "tree-0/a/f1.txt", "tree-0/b/f0.txt"]);
    expect(lotsFor("wv-0")[0]).toEqual({ barcode: "bc-wv-0-0", lotCode: "lt-wv-0-0", qty: 4 });
  });
});

describe("helix goLive", () => {
  test(
    "launch / offset / barcode goLive PASS; wrap serve turns===1",
    async () => {
      const cases: Array<{ name: string; factory: () => World; goals: Array<Record<string, unknown>> }> = [
        { name: "launch-pad", factory: createLaunchPad, goals: SITES.map((s) => ({ site: s.site, env: s.env })) },
        { name: "gitlab-offset", factory: createGitlabOffset, goals: [...PROJECTS].map((project) => ({ project })) },
        { name: "barcode-lots", factory: createBarcodeLots, goals: [...WAVES].map((wave) => ({ wave })) },
      ];
      for (const c of cases) {
        const s = new Session([[c.name, c.factory]], true);
        for (let i = 0; i < 13; i++) {
          await s.stretch(c.name, c.goals[i % c.goals.length]!, blockSeed(`helix-live-${c.name}-${i}`, i));
        }
        const r = await s.goLive(c.name, { compile: 9, holdout: 3, sandbox: c.factory, maxGram: 26 });
        expect(r.verdict, `${c.name} goLive ${r.verdict}: ${r.reasons.join("; ")}`).toBe("PASS");
        expect(r.program).not.toBeNull();
        const live = new Session([[c.name, c.factory]], true);
        live.addPrograms([r.program!]);
        await live.stretch(c.name, c.goals[0]!, blockSeed(`helix-serve-${c.name}`, 99));
        const fin = live.finish();
        expect(fin.violations, `${c.name} ${fin.violations.join("; ")}`).toEqual([]);
        expect(fin.turns, `${c.name} turns=${fin.turns}`).toBe(1);
      }
    },
    90_000,
  );

  test(
    "retry / tree / unique / sort / reduce goLive PASS; wrap serve turns===1",
    async () => {
      const cases: Array<{ name: string; factory: () => World; goals: Array<Record<string, unknown>> }> = [
        { name: "rate-limit-retry", factory: createRateLimitRetry, goals: [...IMAGE_TAGS].map((tag) => ({ tag })) },
        { name: "fs-tree", factory: createFsTree, goals: [...TREES].map((tree) => ({ tree })) },
        { name: "dedupe-mail", factory: createDedupeMail, goals: [...INBOXES].map((inbox) => ({ inbox })) },
        { name: "prio-queue", factory: createPrioQueue, goals: [...QUEUES].map((queue) => ({ queue })) },
        { name: "ledger-settle", factory: createLedgerSettle, goals: [...BATCHES].map((batch) => ({ batch })) },
      ];
      for (const c of cases) {
        const s = new Session([[c.name, c.factory]], true);
        for (let i = 0; i < 13; i++) {
          await s.stretch(c.name, c.goals[i % c.goals.length]!, blockSeed(`helix-live-${c.name}-${i}`, i));
        }
        const r = await s.goLive(c.name, { compile: 9, holdout: 3, sandbox: c.factory, maxGram: 26 });
        expect(r.verdict, `${c.name} goLive ${r.verdict}: ${r.reasons.join("; ")}`).toBe("PASS");
        expect(r.program).not.toBeNull();
        const live = new Session([[c.name, c.factory]], true);
        live.addPrograms([r.program!]);
        await live.stretch(c.name, c.goals[0]!, blockSeed(`helix-serve-${c.name}`, 99));
        const fin = live.finish();
        expect(fin.violations, `${c.name} ${fin.violations.join("; ")}`).toEqual([]);
        expect(fin.turns, `${c.name} turns=${fin.turns}`).toBe(1);
      }
    },
    120_000,
  );
});
