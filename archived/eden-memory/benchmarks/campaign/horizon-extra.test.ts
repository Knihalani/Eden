/**
 * Extra horizon shapes: nested outer-scope k8s, email tz, s3 versionId,
 * 3-way sev fork, set-diff, four-level JSON. CompileTraces + one goLive
 * batch. FAIL not skip-as-win.
 */
import { describe, expect, test } from "bun:test";
import { compileTraces } from "@eden/compile";
import { mulberry32 } from "@eden/measure";
import type { StretchTrace } from "@eden/ir";
import { type CallResult, type World, blockSeed } from "./worlds";
import { Session } from "./session";
import {
  ACCOUNT_IDS,
  BUCKET_IDS,
  CAMPAIGN_IDS,
  DELTA_WAVES,
  EXTRA_HORIZON_FACTORIES,
  NEST_CLUSTERS,
  SEV_ALERTS,
  createDelta,
  createDeepBill,
  createEmailDrip,
  createK8sNested,
  createS3Restore,
  createSevTriage,
  nestNs,
  nestPods,
  sevFor,
  subsFor,
  versionsFor,
} from "./horizon-extra-worlds";

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
    const t0 = performance.now();
    let out: CallResult;
    try {
      const v = await tools[tool]!.execute(args);
      out = { ok: true, value: v };
      lastValue = v;
    } catch (err) {
      out = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    events.push({
      name: tool,
      args,
      result: out.ok ? out.value : { error: out.error },
      ok: out.ok,
      duration_ms: performance.now() - t0,
    });
    sent = out;
    if (out.ok && world.done(out.value)) break;
  }
  return {
    id: `${world.name}-${seed}`,
    events,
    input: goal,
    output: lastValue,
    llmCalls: events.length,
    duration_ms: Math.max(1, Math.round(events.reduce((a, e) => a + (e.duration_ms ?? 0), 0))),
    cost_cents: events.length,
    skipped: [],
    complete: true,
  };
}

async function recordN(factory: () => World, goals: Array<Record<string, unknown>>, n = 4): Promise<StretchTrace[]> {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < n; i++) traces.push(await recordStretch(factory(), goals[i % goals.length]!, 200 + i));
  return traces;
}

describe("horizon extra: contract", () => {
  test("extra factories expose the World surface", () => {
    for (const factory of EXTRA_HORIZON_FACTORIES) {
      const w = factory();
      expect(typeof w.tools).toBe("function");
      expect(typeof w.script).toBe("function");
      expect(typeof w.check).toBe("function");
      expect(typeof w.done).toBe("function");
      expect(typeof w.terminal).toBe("string");
    }
  });
});

describe("horizon extra: compileTraces", () => {
  test(
    "k8s-nested: inner loop binds patchPod.ns from outer item",
    async () => {
      const traces = await recordN(
        createK8sNested,
        [...NEST_CLUSTERS].map((cluster) => ({ cluster })),
        4,
      );
      const r = compileTraces(traces);
      const p = r.programs.find((q) =>
        q.steps.some(
          (s) => s.kind === "loop" && s.body.some((id) => q.steps.some((x) => x.id === id && x.kind === "loop")),
        ),
      );
      expect(p, `k8s-nested refusals ${r.refusals.map((x) => x.code).join(",")}`).toBeDefined();
      const inner = p!.steps.find((s) => s.kind === "loop" && s.id.includes("inner"));
      const restart = p!.steps.find((s) => s.kind === "tool" && s.tool === "patchPod");
      expect(inner && inner.kind === "loop").toBe(true);
      expect(restart && restart.kind === "tool").toBe(true);
      const outer = p!.steps.find((s) => s.kind === "loop" && inner && s.body.includes(inner.id));
      expect(restart && restart.kind === "tool" ? restart.args.ns : undefined).toEqual({
        kind: "from",
        step: (outer as { item: string }).item,
        path: "name",
      });
      expect(nestNs(NEST_CLUSTERS[0]).length).toBe(2);
      expect(nestPods(nestNs(NEST_CLUSTERS[0])[0]!.name).length).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "email-drip: foreach binds email+segment+tz from the item",
    async () => {
      const traces = await recordN(
        createEmailDrip,
        [...CAMPAIGN_IDS].map((campaign) => ({ campaign })),
        4,
      );
      const r = compileTraces(traces);
      const p = r.programs.find((q) => q.steps.some((s) => s.kind === "loop"));
      expect(p, `email-drip ${r.refusals.map((x) => x.code).join(",")}`).toBeDefined();
      const loop = p!.steps.find((s) => s.kind === "loop")!;
      const send = p!.steps.find((s) => s.kind === "tool" && s.tool === "sendMail");
      expect(send && send.kind === "tool").toBe(true);
      if (loop.kind === "loop" && send && send.kind === "tool") {
        expect(send.args.email).toEqual({ kind: "from", step: loop.item, path: "email" });
        expect(send.args.segment).toEqual({ kind: "from", step: loop.item, path: "segment" });
        expect(send.args.timezone).toEqual({ kind: "from", step: loop.item, path: "timezone" });
      }
      expect(subsFor(CAMPAIGN_IDS[0])[0]).toHaveProperty("tz");
    },
    TIMEOUT,
  );

  test(
    "s3-restore: foreach binds key+versionId",
    async () => {
      const traces = await recordN(
        createS3Restore,
        [...BUCKET_IDS].map((bucket) => ({ bucket })),
        4,
      );
      const r = compileTraces(traces);
      const p = r.programs.find((q) => q.steps.some((s) => s.kind === "loop"));
      expect(p, `s3-restore ${r.refusals.map((x) => x.code).join(",")}`).toBeDefined();
      const loop = p!.steps.find((s) => s.kind === "loop")!;
      const body = p!.steps.find((s) => s.kind === "tool" && s.tool === "createRestore");
      if (loop.kind === "loop" && body && body.kind === "tool") {
        expect(body.args.key).toEqual({ kind: "from", step: loop.item, path: "key" });
        expect(body.args.versionId).toEqual({ kind: "from", step: loop.item, path: "versionId" });
      }
      expect(versionsFor(BUCKET_IDS[0])[0]).toHaveProperty("versionId");
    },
    TIMEOUT,
  );

  test(
    "sev-triage: one program with one n-way branch",
    async () => {
      const traces = await recordN(
        createSevTriage,
        [...SEV_ALERTS].map((alert) => ({ alert })),
        9,
      );
      expect(new Set(traces.map((t) => sevFor(String(t.input!.alert)))).size).toBe(3);
      const r = compileTraces(traces);
      const p = r.programs.find((q) => {
        const brs = q.steps.filter((s) => s.kind === "branch");
        return brs.length === 1 && brs[0]!.kind === "branch" && (brs[0].cases?.length ?? 0) >= 1;
      });
      expect(
        p,
        `sev-triage programs=${r.programs.length} refusals=${r.refusals.map((x) => x.code).join(",")}`,
      ).toBeDefined();
      expect(r.programs.filter((q) => q.steps.some((s) => s.kind === "branch")).length).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "delta: foreach over except(desired, current)",
    async () => {
      const traces = await recordN(
        createDelta,
        [...DELTA_WAVES].map((wave) => ({ wave })),
        4,
      );
      const r = compileTraces(traces);
      const p = r.programs.find((q) =>
        q.steps.some((s) => s.kind === "loop" && s.over.kind === "transform" && s.over.fn === "except"),
      );
      expect(p, `delta ${r.refusals.map((x) => x.code).join(",")}`).toBeDefined();
    },
    TIMEOUT,
  );

  test(
    "deep-bill: chargeCard.token from org.billing.card.token",
    async () => {
      const traces = await recordN(
        createDeepBill,
        [...ACCOUNT_IDS].map((account) => ({ account })),
        4,
      );
      const r = compileTraces(traces);
      const p = r.programs.find((q) => q.steps.some((s) => s.kind === "tool" && s.tool === "chargeCard"));
      expect(p, `deep-bill ${r.refusals.map((x) => x.code).join(",")}`).toBeDefined();
      const charge = p!.steps.find((s) => s.kind === "tool" && s.tool === "chargeCard");
      expect(charge && charge.kind === "tool" ? charge.args.token : undefined).toEqual({
        kind: "from",
        step: "getAccount",
        path: "org.billing.card.token",
      });
    },
    TIMEOUT,
  );
});

describe("horizon extra: goLive", () => {
  test("k8s-nested / email / s3 / delta / deep-bill goLive PASS; wrap serve turns===1", async () => {
    const cases: Array<{ name: string; factory: () => World; goals: Array<Record<string, unknown>> }> = [
      { name: "k8s-nested", factory: createK8sNested, goals: [...NEST_CLUSTERS].map((cluster) => ({ cluster })) },
      { name: "email-drip", factory: createEmailDrip, goals: [...CAMPAIGN_IDS].map((campaign) => ({ campaign })) },
      { name: "s3-restore", factory: createS3Restore, goals: [...BUCKET_IDS].map((bucket) => ({ bucket })) },
      { name: "delta", factory: createDelta, goals: [...DELTA_WAVES].map((wave) => ({ wave })) },
      { name: "deep-bill", factory: createDeepBill, goals: [...ACCOUNT_IDS].map((account) => ({ account })) },
    ];
    for (const c of cases) {
      const s = new Session([[c.name, c.factory]], true, NO_THINK);
      for (let i = 0; i < 13; i++) {
        await s.stretch(c.name, c.goals[i % c.goals.length]!, blockSeed(`extra-live-${c.name}-${i}`, i));
      }
      const r = await s.goLive(c.name, { compile: 9, holdout: 3, sandbox: c.factory, maxGram: 26 });
      expect(r.verdict, `${c.name} goLive ${r.verdict}: ${r.reasons.join("; ")}`).toBe("PASS");
      expect(r.program).not.toBeNull();
      const live = new Session([[c.name, c.factory]], true, NO_THINK);
      live.addPrograms([r.program!]);
      await live.stretch(c.name, c.goals[0]!, blockSeed(`extra-serve-${c.name}`, 99));
      const fin = live.finish();
      expect(fin.violations, `${c.name} ${fin.violations.join("; ")}`).toEqual([]);
      expect(fin.turns, `${c.name} turns=${fin.turns}`).toBe(1);
    }
  }, 90_000);

  test("sev-triage goLive PASS with a branched program — FAIL loudly, never skip-as-win", async () => {
    const goals = [...SEV_ALERTS].map((alert) => ({ alert }));
    const s = new Session([["sev-triage", createSevTriage]], true, NO_THINK);
    // Same witness budget as the other extras: 13 / compile 9 / holdout 3.
    // A 3-arm fork is one shape family; 13 must PASS (not SKIP as thin arms).
    for (let i = 0; i < 13; i++) {
      await s.stretch("sev-triage", goals[i % goals.length]!, blockSeed(`extra-live-sev-${i}`, i));
    }
    const r = await s.goLive("sev-triage", { compile: 9, holdout: 3, sandbox: createSevTriage, maxGram: 26 });
    expect(r.verdict, `sev-triage goLive ${r.verdict}: ${r.reasons.join("; ")}`).toBe("PASS");
    expect(r.program).not.toBeNull();
    const brs = r.program!.steps.filter((s) => s.kind === "branch");
    expect(brs).toHaveLength(1);
    expect(brs[0]!.kind === "branch" && (brs[0].cases?.length ?? 0) >= 1).toBe(true);
  }, 60_000);
});
