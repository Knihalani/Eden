/**
 * Moonshot campaign CI: world contracts, compileTraces, unique-work empty,
 * check() duplicates, and compileTraces → shadow goLive → wrap serve.
 *
 * Compile/check tests stay fast. The goLive test is allowed 60s.
 * goLive failure is FAIL with reasons — never skip-as-win.
 */
import { describe, expect, test } from "bun:test";
import { compileTraces } from "@eden/compile";
import { mulberry32 } from "@eden/measure";
import type { StretchTrace } from "@eden/ir";
import { type CallResult, type World, blockSeed } from "./worlds";
import { Session } from "./session";
import {
  FLAG_IDS,
  FLAG_WIDTH,
  GH_WIDTH,
  INV_WIDTH,
  JOB_IDS,
  MOONSHOT_WORLD_FACTORIES,
  NOISE_IDS,
  PR_IDS,
  STACK_IDS,
  TENANT_ORGS,
  WAVE_IDS,
  ZONE_IDS,
  binsFor,
  chunksFor,
  cohortsFor,
  createDnsTls,
  createFlags,
  createGithubPr,
  createInventory,
  createMapReduce,
  createMoonshotNoise,
  createTenant,
  createTerraform,
  filesFor,
  hostsFor,
} from "./moonshot-worlds";

process.env.CAMPAIGN_THINK_MS = "0";

const TIMEOUT = 5_000;

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
  }
  const completed = events.some((e) => e.ok && e.name === world.terminal);
  return {
    id: `${world.name}-${seed}`,
    events,
    input: goal,
    output: lastValue,
    llmCalls: events.length,
    duration_ms: Math.max(1, Math.round(events.reduce((a, e) => a + (e.duration_ms ?? 0), 0))),
    cost_cents: events.length,
    skipped: [],
    complete: completed,
  };
}

async function recordN(factory: () => World, goals: Array<Record<string, unknown>>, n = 4): Promise<StretchTrace[]> {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    traces.push(await recordStretch(factory(), goals[i % goals.length]!, 100 + i));
  }
  return traces;
}

describe("moonshot worlds: contract", () => {
  test(
    "each world exposes tools, script, check",
    () => {
      for (const factory of [...MOONSHOT_WORLD_FACTORIES, createMoonshotNoise]) {
        const w = factory();
        expect(typeof w.tools).toBe("function");
        expect(typeof w.script).toBe("function");
        expect(typeof w.check).toBe("function");
        expect(typeof w.done).toBe("function");
        expect(typeof w.terminal).toBe("string");
        const tools = w.tools();
        expect(Object.keys(tools).length).toBeGreaterThan(0);
        for (const t of Object.values(tools)) {
          expect(typeof t.execute).toBe("function");
          expect(typeof t.description).toBe("string");
        }
      }
    },
    TIMEOUT,
  );

  test(
    "github listFiles returns object items { path, sha }, width 3",
    async () => {
      const w = createGithubPr();
      const listed = await w.tools().listFiles!.execute({ pr: PR_IDS[0] });
      const files = (listed as { files: unknown }).files;
      expect(Array.isArray(files)).toBe(true);
      expect((files as unknown[]).length).toBe(GH_WIDTH);
      expect(typeof (files as unknown[])[0]).toBe("object");
      expect(typeof (files as string[])[0]).not.toBe("string");
      const row = (files as Array<{ path: string; sha: string }>)[0]!;
      expect(typeof row.path).toBe("string");
      expect(typeof row.sha).toBe("string");
      expect(filesFor(PR_IDS[0]).length).toBe(GH_WIDTH);
    },
    TIMEOUT,
  );

  test(
    "inventory listBins returns object items { sku, qty, warehouse }, three fields",
    async () => {
      const w = createInventory();
      const listed = await w.tools().listBins!.execute({ wave: WAVE_IDS[0] });
      const bins = (listed as { bins: unknown }).bins;
      expect(Array.isArray(bins)).toBe(true);
      expect((bins as unknown[]).length).toBe(INV_WIDTH);
      const row = (bins as Array<{ sku: string; qty: number; warehouse: string }>)[0]!;
      expect(typeof row.sku).toBe("string");
      expect(typeof row.qty).toBe("number");
      expect(typeof row.warehouse).toBe("string");
      expect(binsFor(WAVE_IDS[0]).length).toBe(INV_WIDTH);
    },
    TIMEOUT,
  );

  test(
    "flags listCohorts returns object items { cohort, pct }, two fields",
    async () => {
      const w = createFlags();
      const listed = await w.tools().listCohorts!.execute({ flag: FLAG_IDS[0] });
      const cohorts = (listed as { cohorts: unknown }).cohorts;
      expect(Array.isArray(cohorts)).toBe(true);
      expect((cohorts as unknown[]).length).toBe(FLAG_WIDTH);
      const row = (cohorts as Array<{ cohort: string; pct: number }>)[0]!;
      expect(typeof row.cohort).toBe("string");
      expect(typeof row.pct).toBe("number");
      expect(cohortsFor(FLAG_IDS[0]).length).toBe(FLAG_WIDTH);
    },
    TIMEOUT,
  );

  test(
    "tenant goals are two-key { orgId, plan }",
    () => {
      expect(TENANT_ORGS[0]).toHaveProperty("orgId");
      expect(TENANT_ORGS[0]).toHaveProperty("plan");
      expect(Object.keys(TENANT_ORGS[0]).sort()).toEqual(["orgId", "plan"]);
    },
    TIMEOUT,
  );
});

describe("moonshot worlds: compileTraces", () => {
  test(
    "repeating worlds: 4 recorded stretches produce ≥1 program",
    async () => {
      const cases: Array<{
        name: string;
        factory: () => World;
        goals: Array<Record<string, unknown>>;
        seq?: string[];
      }> = [
        {
          name: "terraform",
          factory: createTerraform,
          goals: [...STACK_IDS].map((stack) => ({ stack })),
          seq: ["showPlan", "applyChange", "applyChange", "applyChange", "verifyOutputs"],
        },
        {
          name: "flags",
          factory: createFlags,
          goals: [...FLAG_IDS].map((flag) => ({ flag })),
        },
        {
          name: "dns-tls",
          factory: createDnsTls,
          goals: [...ZONE_IDS].map((zone) => ({ zone })),
        },
      ];
      for (const c of cases) {
        const traces = await recordN(c.factory, c.goals, 4);
        expect(traces.every((t) => t.complete)).toBe(true);
        const r = compileTraces(traces);
        console.log(
          `moonshot compile ${c.name}: programs=${r.programs.length} seqs=${r.programs.map((p) => p.sequence.join("→")).join(" | ") || "(none)"} refusals=${r.refusals.map((x) => x.code ?? x.reason).slice(0, 3).join("; ")}`,
        );
        expect(r.programs.length, `${c.name} should compile ≥1 program`).toBeGreaterThanOrEqual(1);
        if (c.seq) expect(r.programs[0]!.sequence).toEqual(c.seq);
      }
    },
    TIMEOUT,
  );

  test(
    "tenant: seqLen≥5 and two envelope keys orgId+plan",
    async () => {
      const goals = TENANT_ORGS.map((t) => ({ orgId: t.orgId, plan: t.plan }));
      const traces = await recordN(createTenant, goals, 4);
      expect(traces.every((t) => t.complete)).toBe(true);
      const r = compileTraces(traces);
      console.log(
        `moonshot compile tenant: programs=${r.programs.length} seqs=${r.programs.map((p) => p.sequence.join("→")).join(" | ") || "(none)"} env=${JSON.stringify(Object.keys(r.programs[0]?.contract.envelope?.inputs ?? {}))} refusals=${r.refusals.map((x) => x.code ?? x.reason).slice(0, 3).join("; ")}`,
      );
      expect(r.programs.length, "tenant should compile ≥1 program").toBeGreaterThanOrEqual(1);
      expect(r.programs[0]!.sequence.length).toBeGreaterThanOrEqual(5);
      expect(r.programs[0]!.sequence).toEqual([
        "createTenant",
        "createDb",
        "createRoles",
        "createBilling",
        "sendWelcome",
      ]);
      const envKeys = Object.keys(r.programs[0]!.contract.envelope?.inputs ?? {}).sort();
      expect(envKeys).toEqual(["orgId", "plan"]);
    },
    TIMEOUT,
  );

  test(
    "github-pr: compiles a loop over { path, sha } files",
    async () => {
      const goals = [...PR_IDS].map((pr) => ({ pr }));
      const traces = await recordN(createGithubPr, goals, 4);
      expect(traces[0]!.events.filter((e) => e.name === "createReviewComment").length).toBe(GH_WIDTH);
      const r = compileTraces(traces);
      const looped = r.programs.filter((p) => p.steps.some((s) => s.kind === "loop"));
      console.log(
        `moonshot compile github-pr: programs=${r.programs.length} loops=${looped.length} seqs=${r.programs.map((p) => p.sequence.join("→")).join(" | ") || "(none)"} refusals=${r.refusals.map((x) => x.code ?? x.reason).slice(0, 4).join("; ")}`,
      );
      expect(r.programs.length, "github-pr should compile ≥1 program").toBeGreaterThanOrEqual(1);
      expect(looped.length, "github-pr should have a foreach").toBeGreaterThanOrEqual(1);
      const over = looped[0]!.steps.find((s) => s.kind === "loop");
      expect(over && over.kind === "loop" && over.over).toMatchObject({ path: "files" });
    },
    TIMEOUT,
  );

  test(
    "inventory: compiles a loop over { sku, qty, warehouse } bins",
    async () => {
      const goals = [...WAVE_IDS].map((wave) => ({ wave }));
      const traces = await recordN(createInventory, goals, 4);
      expect(traces[0]!.events.filter((e) => e.name === "restockLine").length).toBe(INV_WIDTH);
      const r = compileTraces(traces);
      const looped = r.programs.filter((p) => p.steps.some((s) => s.kind === "loop"));
      console.log(
        `moonshot compile inventory: programs=${r.programs.length} loops=${looped.length} seqs=${r.programs.map((p) => p.sequence.join("→")).join(" | ") || "(none)"} refusals=${r.refusals.map((x) => x.code ?? x.reason).slice(0, 4).join("; ")}`,
      );
      expect(r.programs.length, "inventory should compile ≥1 program").toBeGreaterThanOrEqual(1);
      expect(looped.length, "inventory should have a foreach").toBeGreaterThanOrEqual(1);
      const over = looped[0]!.steps.find((s) => s.kind === "loop");
      expect(over && over.kind === "loop" && over.over).toMatchObject({ path: "bins" });
    },
    TIMEOUT,
  );

  test(
    "map-reduce: foreach over chunks then mergeReport.rows binds from the loop",
    async () => {
      const goals = [...JOB_IDS].map((job) => ({ job }));
      const traces = await recordN(createMapReduce, goals, 4);
      expect(traces[0]!.events.filter((e) => e.name === "mapChunk").length).toBe(chunksFor(JOB_IDS[0]).length);
      const r = compileTraces(traces);
      const looped = r.programs.filter((p) => p.steps.some((s) => s.kind === "loop"));
      console.log(
        `moonshot compile map-reduce: programs=${r.programs.length} loops=${looped.length} seqs=${r.programs.map((p) => p.sequence.join("→")).join(" | ") || "(none)"} refusals=${r.refusals.map((x) => x.code ?? x.reason).slice(0, 4).join("; ")}`,
      );
      expect(r.programs.length, "map-reduce should compile ≥1 program").toBeGreaterThanOrEqual(1);
      expect(looped.length, "map-reduce should have a foreach over chunks").toBeGreaterThanOrEqual(1);
      const merge = r.programs[0]!.steps.find((s) => s.kind === "tool" && s.tool === "mergeReport") as
        | { args?: Record<string, { kind?: string; step?: string }> }
        | undefined;
      expect(merge?.args?.rows?.kind, "mergeReport.rows should bind from the loop").toBe("from");
      expect(r.refusals.some((x) => x.code === "underdetermined_write")).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "unique-work (moonshot-noise) compiles 0 programs",
    async () => {
      const goals = [...NOISE_IDS].slice(0, 4).map((id) => ({ id }));
      const traces = await recordN(createMoonshotNoise, goals, 4);
      const seqs = traces.map((t) => t.events.map((e) => e.name).join("→"));
      expect(new Set(seqs).size).toBe(seqs.length);
      const r = compileTraces(traces);
      expect(r.programs.length).toBe(0);
    },
    TIMEOUT,
  );
});

describe("moonshot worlds: check() catches duplicated mutation", () => {
  test(
    "github-pr: poking createReviewComment twice fires duplicated",
    async () => {
      const w = createGithubPr();
      const tools = w.tools();
      const pr = PR_IDS[0];
      const path = filesFor(pr)[0]!.path;
      await tools.createReviewComment!.execute({ path, sha: "deadbeef" });
      await tools.createReviewComment!.execute({ path, sha: "deadbeef" });
      const bad = w.check([{ pr }]);
      expect(bad.some((v) => v.includes("createReviewComment") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "terraform: poking applyChange twice fires duplicated",
    async () => {
      const w = createTerraform();
      const tools = w.tools();
      const stack = STACK_IDS[0];
      const address = `${stack}.aws_s3.bucket`;
      await tools.applyChange!.execute({ address });
      await tools.applyChange!.execute({ address });
      const bad = w.check([{ stack }]);
      expect(bad.some((v) => v.includes("applyChange") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "flags: poking setRollout twice fires duplicated",
    async () => {
      const w = createFlags();
      const tools = w.tools();
      const flag = FLAG_IDS[0];
      const cohort = cohortsFor(flag)[0]!.cohort;
      await tools.setRollout!.execute({ cohort, pct: 5 });
      await tools.setRollout!.execute({ cohort, pct: 5 });
      const bad = w.check([{ flag }]);
      expect(bad.some((v) => v.includes("setRollout") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "dns-tls: poking createCert twice fires duplicated",
    async () => {
      const w = createDnsTls();
      const tools = w.tools();
      const zone = ZONE_IDS[0];
      const host = hostsFor(zone)[0]!;
      await tools.createCert!.execute({ host });
      await tools.createCert!.execute({ host });
      const bad = w.check([{ zone }]);
      expect(bad.some((v) => v.includes("createCert") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "inventory: poking restockLine twice fires duplicated",
    async () => {
      const w = createInventory();
      const tools = w.tools();
      const wave = WAVE_IDS[0];
      const sku = binsFor(wave)[0]!.sku;
      await tools.restockLine!.execute({ sku, qty: 1, warehouse: "WH-x" });
      await tools.restockLine!.execute({ sku, qty: 1, warehouse: "WH-x" });
      const bad = w.check([{ wave }]);
      expect(bad.some((v) => v.includes("restockLine") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "tenant: poking createTenant twice fires duplicated",
    async () => {
      const w = createTenant();
      const tools = w.tools();
      const slot = { orgId: TENANT_ORGS[0].orgId, plan: TENANT_ORGS[0].plan };
      await tools.createTenant!.execute(slot);
      await tools.createTenant!.execute(slot);
      const bad = w.check([slot]);
      expect(bad.some((v) => v.includes("createTenant") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "map-reduce: poking mergeReport twice fires duplicated",
    async () => {
      const w = createMapReduce();
      const tools = w.tools();
      const job = JOB_IDS[0];
      await tools.mergeReport!.execute({ job });
      await tools.mergeReport!.execute({ job });
      const bad = w.check([{ job }]);
      expect(bad.some((v) => v.includes("mergeReport") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );
});

describe("moonshot worlds: compileTraces → shadow goLive", () => {
  test(
    "github / tenant / inventory goLive PASS with a certified program; wrap serve turns===1",
    async () => {
      const cases: Array<{
        name: string;
        factory: () => World;
        goals: Array<Record<string, unknown>>;
      }> = [
        { name: "github-pr", factory: createGithubPr, goals: [...PR_IDS].map((pr) => ({ pr })) },
        { name: "tenant", factory: createTenant, goals: TENANT_ORGS.map((t) => ({ orgId: t.orgId, plan: t.plan })) },
        { name: "inventory", factory: createInventory, goals: [...WAVE_IDS].map((wave) => ({ wave })) },
      ];
      for (const c of cases) {
        const s = new Session([[c.name, c.factory]], true);
        for (let i = 0; i < 13; i++) {
          await s.stretch(c.name, c.goals[i % c.goals.length]!, blockSeed(`moonshot-live-${c.name}-${i}`, i));
        }
        const r = await s.goLive(c.name, {
          compile: 9,
          holdout: 3,
          sandbox: c.factory,
          maxGram: 26,
        });
        expect(r.verdict, `${c.name} goLive ${r.verdict}: ${r.reasons.join("; ")}`).toBe("PASS");
        expect(r.program, `${c.name} program`).not.toBeNull();
        expect(r.program!.manifest?.certified).toBe(true);
        const live = new Session([[c.name, c.factory]], true);
        live.addPrograms([r.program!]);
        await live.stretch(c.name, c.goals[0]!, blockSeed(`moonshot-serve-${c.name}`, 99));
        const fin = live.finish();
        expect(fin.violations, `${c.name} wrap serve ${fin.violations.join("; ")}`).toEqual([]);
        expect(fin.turns, `${c.name} wrap serve turns=${fin.turns} (want 1)`).toBe(1);
      }
    },
    60_000,
  );

  test(
    "terraform / flags / dns-tls goLive PASS with a certified program; wrap serve turns===1",
    async () => {
      const cases: Array<{
        name: string;
        factory: () => World;
        goals: Array<Record<string, unknown>>;
      }> = [
        { name: "terraform", factory: createTerraform, goals: [...STACK_IDS].map((stack) => ({ stack })) },
        { name: "flags", factory: createFlags, goals: [...FLAG_IDS].map((flag) => ({ flag })) },
        { name: "dns-tls", factory: createDnsTls, goals: [...ZONE_IDS].map((zone) => ({ zone })) },
      ];
      for (const c of cases) {
        const s = new Session([[c.name, c.factory]], true);
        for (let i = 0; i < 13; i++) {
          await s.stretch(c.name, c.goals[i % c.goals.length]!, blockSeed(`moonshot-live-${c.name}-${i}`, i));
        }
        const r = await s.goLive(c.name, {
          compile: 9,
          holdout: 3,
          sandbox: c.factory,
          maxGram: 26,
        });
        expect(r.verdict, `${c.name} goLive ${r.verdict}: ${r.reasons.join("; ")}`).toBe("PASS");
        expect(r.program, `${c.name} program`).not.toBeNull();
        expect(r.program!.manifest?.certified).toBe(true);
        const live = new Session([[c.name, c.factory]], true);
        live.addPrograms([r.program!]);
        await live.stretch(c.name, c.goals[0]!, blockSeed(`moonshot-serve-${c.name}`, 99));
        const fin = live.finish();
        expect(fin.violations, `${c.name} wrap serve ${fin.violations.join("; ")}`).toEqual([]);
        expect(fin.turns, `${c.name} wrap serve turns=${fin.turns} (want 1)`).toBe(1);
      }
    },
    90_000,
  );

  test(
    "map-reduce goLive PASS with a certified program; wrap serve turns===1",
    async () => {
      const goals = [...JOB_IDS].map((job) => ({ job }));
      const s = new Session([["map-reduce", createMapReduce]], true);
      for (let i = 0; i < 13; i++) {
        await s.stretch("map-reduce", goals[i % goals.length]!, blockSeed(`moonshot-live-map-reduce-${i}`, i));
      }
      const r = await s.goLive("map-reduce", {
        compile: 9,
        holdout: 3,
        sandbox: createMapReduce,
        maxGram: 26,
      });
      expect(r.verdict, `map-reduce goLive ${r.verdict}: ${r.reasons.join("; ")}`).toBe("PASS");
      expect(r.program, "map-reduce program").not.toBeNull();
      expect(r.program!.manifest?.certified).toBe(true);
      const rows = r.program!.steps.find((s) => s.kind === "tool" && s.tool === "mergeReport") as
        | { args?: Record<string, { kind?: string }> }
        | undefined;
      expect(rows?.args?.rows?.kind, "certified program still binds rows from the loop").toBe("from");
      const live = new Session([["map-reduce", createMapReduce]], true);
      live.addPrograms([r.program!]);
      await live.stretch("map-reduce", goals[0]!, blockSeed("moonshot-serve-map-reduce", 99));
      const fin = live.finish();
      expect(fin.violations, `map-reduce wrap serve ${fin.violations.join("; ")}`).toEqual([]);
      expect(fin.turns, `map-reduce wrap serve turns=${fin.turns} (want 1)`).toBe(1);
    },
    45_000,
  );
});
