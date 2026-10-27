/**
 * Apex campaign CI: new domains (not a retune). compileTraces + runProgram
 * + check(), unique-work empty, goLive PASS on stripe/sentry/oauth.
 */
import { describe, expect, test } from "bun:test";
import { compileTraces } from "@eden/compile";
import { mulberry32 } from "@eden/measure";
import type { StretchTrace } from "@eden/ir";
import { registryFrom, runProgram } from "@eden/runtime";
import { type CallResult, type World, blockSeed } from "./worlds";
import { Session } from "./session";
import {
  CATS,
  JOBS,
  MERCHANTS,
  NOISE_IDS,
  ORGS,
  SITES,
  STRIPE_INVOICES,
  SVCS,
  USERS,
  createApexNoise,
  createCatalogZip,
  createCmsFlatten,
  createHrisJoin,
  createLogGroup,
  createOauthSession,
  createSentryFilter,
  createStripeInvoices,
  createTranscodeChunk,
} from "./apex-worlds";

// No simulated think time. Setting CAMPAIGN_THINK_MS here would be too late:
// session.ts reads it when it is imported, which happens before this line runs.
const NO_THINK = { thinkMs: 0 };
const TIMEOUT = 8_000;

async function recordStretch(world: World, goal: Record<string, unknown>, seed: number): Promise<StretchTrace> {
  const tools = world.tools();
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
    llmCalls: events.length,
    duration_ms: 1,
    cost_cents: events.length,
    skipped: [],
    complete: true,
  };
}

async function recordN(factory: () => World, goals: Array<Record<string, unknown>>, n = 4): Promise<StretchTrace[]> {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < n; i++) traces.push(await recordStretch(factory(), goals[i % goals.length]!, 300 + i));
  return traces;
}

describe("apex compile + runProgram", () => {
  test("stripe invoices: cursor until + flatten; runProgram posts each invoice once", async () => {
    const goals = [...MERCHANTS.slice(0, 4)].map((merchant) => ({ merchant }));
    const traces = await recordN(createStripeInvoices, goals);
    const { programs, refusals } = compileTraces(traces);
    expect(refusals.filter((r) => r.code === "unbound_foreach")).toEqual([]);
    const p = programs.find((q) => q.steps.some((s) => s.kind === "loop" && s.until));
    expect(p, `stripe program ${refusals.map((r) => r.reason).join("|")}`).toBeTruthy();
    expect(p!.steps.some((s) => s.kind === "loop" && s.over.kind === "transform" && s.over.fn === "flatten")).toBe(
      true,
    );
    const w = createStripeInvoices();
    await runProgram(p!, { merchant: "m0" }, { registry: registryFrom(w.tools()), checkEnvelope: false });
    expect(w.check([{ merchant: "m0" }])).toEqual([]);
    expect(STRIPE_INVOICES.length).toBe(6);
  });

  test("sentry / hris / cms / chunk / zip / oauth compile a program; noise is empty", async () => {
    const cases: Array<{
      name: string;
      factory: () => World;
      goals: Array<Record<string, unknown>>;
      wantLoop?: boolean;
    }> = [
      { name: "sentry", factory: createSentryFilter, goals: SVCS.slice(0, 4).map((q) => ({ q })), wantLoop: true },
      { name: "hris", factory: createHrisJoin, goals: ORGS.slice(0, 4).map((org) => ({ org })), wantLoop: true },
      { name: "cms", factory: createCmsFlatten, goals: SITES.slice(0, 4).map((site) => ({ site })), wantLoop: true },
      { name: "chunk", factory: createTranscodeChunk, goals: JOBS.slice(0, 4).map((job) => ({ job })), wantLoop: true },
      { name: "zip", factory: createCatalogZip, goals: CATS.slice(0, 4).map((cat) => ({ cat })), wantLoop: true },
      { name: "oauth", factory: createOauthSession, goals: USERS.slice(0, 4).map((user) => ({ user })) },
      { name: "group", factory: createLogGroup, goals: SVCS.slice(0, 4).map((svc) => ({ svc })), wantLoop: true },
    ];
    for (const c of cases) {
      const traces = await recordN(c.factory, c.goals);
      const { programs, refusals } = compileTraces(traces);
      const p = programs[0];
      expect(p, `${c.name}: ${refusals.map((r) => r.reason).join("|")}`).toBeTruthy();
      if (c.wantLoop)
        expect(
          p!.steps.some((s) => s.kind === "loop"),
          `${c.name} loop`,
        ).toBe(true);
      const w = c.factory();
      await runProgram(p!, c.goals[0]!, { registry: registryFrom(w.tools()), checkEnvelope: false });
      expect(w.check([c.goals[0]!]), `${c.name} check`).toEqual([]);
    }
    const noise = await recordN(
      createApexNoise,
      NOISE_IDS.slice(0, 4).map((id) => ({ id })),
    );
    const empty = compileTraces(noise);
    expect(empty.programs).toEqual([]);
  });
});

describe("apex goLive", () => {
  test("stripe / sentry / oauth goLive PASS; wrap serve turns===1", async () => {
    const cases: Array<{ name: string; factory: () => World; goals: Array<Record<string, unknown>> }> = [
      {
        name: "stripe-invoices",
        factory: createStripeInvoices,
        goals: [...MERCHANTS].map((merchant) => ({ merchant })),
      },
      { name: "sentry-filter", factory: createSentryFilter, goals: [...SVCS].map((q) => ({ q })) },
      { name: "oauth-session", factory: createOauthSession, goals: [...USERS].map((user) => ({ user })) },
    ];
    for (const c of cases) {
      const s = new Session([[c.name, c.factory]], true, NO_THINK);
      for (let i = 0; i < 13; i++) {
        await s.stretch(c.name, c.goals[i % c.goals.length]!, blockSeed(`apex-live-${c.name}-${i}`, i));
      }
      const r = await s.goLive(c.name, { compile: 9, holdout: 3, sandbox: c.factory, maxGram: 26 });
      expect(r.verdict, `${c.name} goLive ${r.verdict}: ${r.reasons.join("; ")}`).toBe("PASS");
      expect(r.program).not.toBeNull();
      const live = new Session([[c.name, c.factory]], true, NO_THINK);
      live.addPrograms([r.program!]);
      await live.stretch(c.name, c.goals[0]!, blockSeed(`apex-serve-${c.name}`, 99));
      const fin = live.finish();
      expect(fin.violations, `${c.name} ${fin.violations.join("; ")}`).toEqual([]);
      expect(fin.turns, `${c.name} turns=${fin.turns}`).toBe(1);
    }
  }, 60_000);
});
