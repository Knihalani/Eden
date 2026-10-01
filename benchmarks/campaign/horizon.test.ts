/**
 * Horizon campaign CI: world contracts, compileTraces, unique-work empty,
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
  BLOB_IDS,
  DEPLOY_IDS,
  GQL_WIDTH,
  HOLD_FAIL,
  HOLD_IDS,
  HOLD_OK,
  HOOK_IDS,
  HORIZON_WORLD_FACTORIES,
  K8S_POLLS,
  NOISE_IDS,
  QUERY_IDS,
  REPO_IDS,
  REPORT_IDS,
  SEARCH_HITS,
  SEARCH_TAKE,
  SSO_ORGS,
  THREAD_IDS,
  createBlobPipeline,
  createGraphqlRelay,
  createHorizonNoise,
  createInboxTriage,
  createK8sRollout,
  createSagaHold,
  createSearchRandomSubset,
  createSearchRank,
  createSqlReport,
  createSsoProvision,
  createWebhookFanout,
  hitsFor,
  holdStateOf,
  issuesFor,
  nonPrefixHitsFor,
  prefixHitsFor,
  sqlFor,
  ssoBodyFor,
} from "./horizon-worlds";

process.env.CAMPAIGN_THINK_MS = "0";

const TIMEOUT = 5_000;

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

describe("horizon worlds: contract", () => {
  test(
    "each world exposes tools, script, check, done, terminal",
    () => {
      for (const factory of [...HORIZON_WORLD_FACTORIES, createHorizonNoise, createSearchRandomSubset]) {
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
    "graphql listIssues returns Relay edges { node: { id, title } }, width 3, no top-level id on the edge",
    async () => {
      const w = createGraphqlRelay();
      const listed = await w.tools().listIssues!.execute({ repo: REPO_IDS[0] });
      const edges = (listed as { edges: unknown }).edges;
      expect(Array.isArray(edges)).toBe(true);
      expect((edges as unknown[]).length).toBe(GQL_WIDTH);
      const edge = (edges as Array<{ node?: { id?: string; title?: string; number?: number }; id?: unknown }>)[0]!;
      expect(typeof edge).toBe("object");
      expect(edge.id, "edge must NOT have a top-level id — args come from node.*").toBeUndefined();
      expect(typeof edge.node).toBe("object");
      expect(typeof edge.node!.id).toBe("string");
      expect(typeof edge.node!.title).toBe("string");
      expect(typeof edge.node!.number).toBe("number");
      expect(issuesFor(REPO_IDS[0]).length).toBe(GQL_WIDTH);
    },
    TIMEOUT,
  );

  test(
    "sso createUser body is a nested OBJECT, not a string; goal is two-key { orgId, email }",
    async () => {
      expect(SSO_ORGS[0]).toHaveProperty("orgId");
      expect(SSO_ORGS[0]).toHaveProperty("email");
      expect(Object.keys(SSO_ORGS[0]).sort()).toEqual(["email", "orgId"]);
      const slot = SSO_ORGS[0];
      const body = ssoBodyFor(slot.orgId, slot.email);
      expect(typeof body).toBe("object");
      expect(Array.isArray(body)).toBe(false);
      expect(typeof body.user).toBe("object");
      expect(typeof body.user.email).toBe("string");
      expect(typeof body.user.name).toBe("string");
      expect(body.orgId).toBe(slot.orgId);
      const w = createSsoProvision();
      const t = await recordStretch(w, { orgId: slot.orgId, email: slot.email }, 1);
      const created = t.events.find((e) => e.name === "createUser");
      expect(created).toBeDefined();
      const argBody = created!.args.body;
      expect(typeof argBody).toBe("object");
      expect(typeof argBody).not.toBe("string");
      expect((argBody as { user: { email: string } }).user.email).toBe(slot.email);
    },
    TIMEOUT,
  );

  test(
    "searchHits returns 10 hits rank 1..10 score descending; prefix take is first 3",
    async () => {
      const w = createSearchRank();
      const listed = await w.tools().searchHits!.execute({ q: QUERY_IDS[0] });
      const hits = (listed as { hits: Array<{ id: string; score: number; rank: number }> }).hits;
      expect(hits.length).toBe(SEARCH_HITS);
      expect(hits.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const scores = hits.map((h) => h.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      expect(prefixHitsFor(QUERY_IDS[0]).length).toBe(SEARCH_TAKE);
      expect(prefixHitsFor(QUERY_IDS[0]).map((h) => h.id)).toEqual(hits.slice(0, 3).map((h) => h.id));
      expect(hitsFor(QUERY_IDS[0]).length).toBe(SEARCH_HITS);
      const t = await recordStretch(w, { q: QUERY_IDS[0] }, 2);
      const taken = t.events.filter((e) => e.name === "takeHit").map((e) => String(e.args.id));
      expect(taken).toEqual(prefixHitsFor(QUERY_IDS[0]).map((h) => h.id));
    },
    TIMEOUT,
  );

  test(
    "k8s getRollout polls same args three times: false, false, true then verify",
    async () => {
      const w = createK8sRollout();
      const t = await recordStretch(w, { deploy: DEPLOY_IDS[0] }, 3);
      const polls = t.events.filter((e) => e.name === "getRollout");
      expect(polls.length).toBe(K8S_POLLS);
      const args0 = JSON.stringify(polls[0]!.args);
      expect(polls.every((e) => JSON.stringify(e.args) === args0)).toBe(true);
      expect((polls[0]!.result as { ready: boolean }).ready).toBe(false);
      expect((polls[1]!.result as { ready: boolean }).ready).toBe(false);
      expect((polls[2]!.result as { ready: boolean }).ready).toBe(true);
      expect(t.events.filter((e) => e.name === "verifyRollout").length).toBe(1);
      expect(t.events.at(-1)!.name).toBe("verifyRollout");
    },
    TIMEOUT,
  );

  test(
    "saga pool is 50/50 ok/fail with ≥3 ids per arm",
    () => {
      expect(HOLD_OK.length).toBeGreaterThanOrEqual(3);
      expect(HOLD_FAIL.length).toBeGreaterThanOrEqual(3);
      expect(HOLD_IDS.length).toBe(HOLD_OK.length + HOLD_FAIL.length);
      expect(holdStateOf(HOLD_OK[0])).toBe("ok");
      expect(holdStateOf(HOLD_FAIL[0])).toBe("fail");
    },
    TIMEOUT,
  );

  test(
    "sql string varies with report and is not a literal",
    () => {
      const a = sqlFor(REPORT_IDS[0]);
      const b = sqlFor(REPORT_IDS[1]);
      expect(a).not.toEqual(b);
      expect(a).toContain(REPORT_IDS[0]);
      expect(b).toContain(REPORT_IDS[1]);
      expect(a.startsWith("SELECT")).toBe(true);
    },
    TIMEOUT,
  );
});

describe("horizon worlds: compileTraces", () => {
  test(
    "graphql-relay: foreach over.edges with loop args from node",
    async () => {
      const goals = [...REPO_IDS].map((repo) => ({ repo }));
      const traces = await recordN(createGraphqlRelay, goals, 4);
      expect(traces[0]!.events.filter((e) => e.name === "updateIssue").length).toBe(GQL_WIDTH);
      const r = compileTraces(traces);
      const looped = r.programs.filter((p) => p.steps.some((s) => s.kind === "loop"));
      console.log(
        `horizon compile graphql-relay: programs=${r.programs.length} loops=${looped.length} seqs=${r.programs.map((p) => p.sequence.join("→")).join(" | ") || "(none)"} refusals=${r.refusals
          .map((x) => x.code ?? x.reason)
          .slice(0, 4)
          .join("; ")}`,
      );
      expect(r.programs.length, "graphql-relay should compile ≥1 program").toBeGreaterThanOrEqual(1);
      expect(looped.length, "graphql-relay should have a foreach over edges").toBeGreaterThanOrEqual(1);
      const over = looped[0]!.steps.find((s) => s.kind === "loop");
      expect(over && over.kind === "loop" && over.over).toMatchObject({ path: "edges" });
      const body = looped[0]!.steps.find((s) => s.kind === "tool" && s.tool === "updateIssue") as
        { args?: Record<string, { kind?: string; path?: string }> } | undefined;
      expect(body?.args?.id?.path, "updateIssue.id should bind from node.id, not a top-level edge id").toMatch(
        /node\.id/,
      );
      expect(body?.args?.title?.path, "updateIssue.title should bind from node.title").toMatch(/node\.title/);
    },
    TIMEOUT,
  );

  test(
    "sso: seqLen≥4 and body bound (nested object, not a string)",
    async () => {
      const goals = SSO_ORGS.map((t) => ({ orgId: t.orgId, email: t.email }));
      const traces = await recordN(createSsoProvision, goals, 4);
      expect(traces.every((t) => t.complete)).toBe(true);
      expect(traces[0]!.events.map((e) => e.name)).toEqual(["getOrg", "createUser", "grantRole", "sendInvite"]);
      const r = compileTraces(traces);
      console.log(
        `horizon compile sso: programs=${r.programs.length} ` +
          `seqs=${r.programs.map((p) => p.sequence.join("→")).join(" | ") || "(none)"} ` +
          `env=${JSON.stringify(Object.keys(r.programs[0]?.contract.envelope?.inputs ?? {}))} refusals=${r.refusals
            .map((x) => x.code ?? x.reason)
            .slice(0, 4)
            .join("; ")}`,
      );
      expect(r.programs.length, "sso should compile ≥1 program").toBeGreaterThanOrEqual(1);
      expect(r.programs[0]!.sequence.length).toBeGreaterThanOrEqual(4);
      const envKeys = Object.keys(r.programs[0]!.contract.envelope?.inputs ?? {}).sort();
      expect(envKeys).toEqual(["email", "orgId"]);
      const create = r.programs[0]!.steps.find((s) => s.kind === "tool" && s.tool === "createUser") as
        { args?: Record<string, { kind?: string; step?: string; path?: string }> } | undefined;
      expect(create?.args?.body, "createUser.body must be bound").toBeDefined();
      const body = create?.args?.body;
      expect(
        body?.kind === "from" || body?.kind === "transform" || body?.kind === "input",
        `createUser.body must be a bound object (from/transform/input), got ${JSON.stringify(body)}`,
      ).toBe(true);
      if (body?.kind === "transform") {
        expect(body.fn, "createUser.body transform must be a template, not a string concat guess").toBe("template");
        expect(body.expr.trim().startsWith("{"), "createUser.body must be a JSON object template, not a string").toBe(
          true,
        );
      }
      if (body?.kind === "literal") {
        expect(typeof (body as { value?: unknown }).value, "createUser.body must not be a string literal").not.toBe(
          "string",
        );
      }
    },
    TIMEOUT,
  );

  test(
    "unique-work (horizon-noise) compiles 0 programs",
    async () => {
      const goals = [...NOISE_IDS].slice(0, 4).map((id) => ({ id }));
      const traces = await recordN(createHorizonNoise, goals, 4);
      const seqs = traces.map((t) => t.events.map((e) => e.name).join("→"));
      expect(new Set(seqs).size).toBe(seqs.length);
      const r = compileTraces(traces);
      expect(r.programs.length).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "search random non-prefix subset compiles 0 programs (must refuse)",
    async () => {
      const goals = [...QUERY_IDS].map((q) => ({ q }));
      const traces = await recordN(createSearchRandomSubset, goals, 4);
      expect(traces[0]!.events.filter((e) => e.name === "takeHit").length).toBe(SEARCH_TAKE);
      const taken = traces[0]!.events.filter((e) => e.name === "takeHit").map((e) => String(e.args.id));
      const prefix = new Set(prefixHitsFor(QUERY_IDS[0]).map((h) => h.id));
      expect(taken.every((id) => !prefix.has(id))).toBe(true);
      expect(taken).toEqual(nonPrefixHitsFor(QUERY_IDS[0]).map((h) => h.id));
      const r = compileTraces(traces);
      console.log(
        `horizon compile search-random-subset: programs=${r.programs.length} refusals=${r.refusals
          .map((x) => x.code ?? x.reason)
          .slice(0, 3)
          .join("; ")}`,
      );
      expect(r.programs.length, "non-prefix top-k must still refuse").toBe(0);
    },
    TIMEOUT,
  );
});

describe("horizon worlds: check() catches duplicated mutation", () => {
  test(
    "graphql-relay: poking updateIssue twice fires duplicated",
    async () => {
      const w = createGraphqlRelay();
      const tools = w.tools();
      const repo = REPO_IDS[0];
      const id = issuesFor(repo)[0]!.node.id;
      await tools.updateIssue!.execute({ id, title: "x" });
      await tools.updateIssue!.execute({ id, title: "x" });
      const bad = w.check([{ repo }]);
      expect(bad.some((v) => v.includes("updateIssue") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "sso: poking createUser twice fires duplicated",
    async () => {
      const w = createSsoProvision();
      const tools = w.tools();
      const slot = { orgId: SSO_ORGS[0].orgId, email: SSO_ORGS[0].email };
      const body = ssoBodyFor(slot.orgId, slot.email);
      await tools.createUser!.execute({ body });
      await tools.createUser!.execute({ body });
      const bad = w.check([slot]);
      expect(bad.some((v) => v.includes("createUser") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "search-rank: poking takeHit twice fires duplicated",
    async () => {
      const w = createSearchRank();
      const tools = w.tools();
      const q = QUERY_IDS[0];
      const id = prefixHitsFor(q)[0]!.id;
      await tools.takeHit!.execute({ id });
      await tools.takeHit!.execute({ id });
      const bad = w.check([{ q }]);
      expect(bad.some((v) => v.includes("takeHit") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "k8s-rollout: poking verifyRollout twice fires duplicated",
    async () => {
      const w = createK8sRollout();
      const tools = w.tools();
      const deploy = DEPLOY_IDS[0];
      await tools.verifyRollout!.execute({ deploy });
      await tools.verifyRollout!.execute({ deploy });
      const bad = w.check([{ deploy }]);
      expect(bad.some((v) => v.includes("verifyRollout") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "saga-hold: poking captureFunds twice fires duplicated",
    async () => {
      const w = createSagaHold();
      const tools = w.tools();
      const holdId = HOLD_OK[0];
      await tools.captureFunds!.execute({ holdId });
      await tools.captureFunds!.execute({ holdId });
      const bad = w.check([{ holdId }]);
      expect(bad.some((v) => v.includes("captureFunds") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "saga-hold: poking cancelHold twice fires duplicated",
    async () => {
      const w = createSagaHold();
      const tools = w.tools();
      const holdId = HOLD_FAIL[0];
      await tools.cancelHold!.execute({ holdId });
      await tools.cancelHold!.execute({ holdId });
      const bad = w.check([{ holdId }]);
      expect(bad.some((v) => v.includes("cancelHold") && v.includes("duplicated"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "webhook-fanout: poking notifySlack twice fails exactly-once",
    async () => {
      const w = createWebhookFanout();
      const tools = w.tools();
      const hook = HOOK_IDS[0];
      await tools.notifySlack!.execute({ hook });
      await tools.notifySlack!.execute({ hook });
      await tools.writeAudit!.execute({ hook });
      await tools.ackEvent!.execute({ hook });
      const bad = w.check([{ hook }]);
      expect(bad.some((v) => v.includes("notifySlack"))).toBe(true);
    },
    TIMEOUT,
  );
});

describe("horizon worlds: compileTraces → shadow goLive", () => {
  test("graphql / sso / sql / blob / inbox / webhook goLive PASS with a certified program; wrap serve turns===1", async () => {
    const cases: Array<{
      name: string;
      factory: () => World;
      goals: Array<Record<string, unknown>>;
    }> = [
      { name: "graphql-relay", factory: createGraphqlRelay, goals: [...REPO_IDS].map((repo) => ({ repo })) },
      { name: "sso", factory: createSsoProvision, goals: SSO_ORGS.map((t) => ({ orgId: t.orgId, email: t.email })) },
      { name: "sql-report", factory: createSqlReport, goals: [...REPORT_IDS].map((report) => ({ report })) },
      { name: "blob-pipeline", factory: createBlobPipeline, goals: [...BLOB_IDS].map((blob) => ({ blob })) },
      { name: "inbox-triage", factory: createInboxTriage, goals: [...THREAD_IDS].map((thread) => ({ thread })) },
      { name: "webhook-fanout", factory: createWebhookFanout, goals: [...HOOK_IDS].map((hook) => ({ hook })) },
    ];
    for (const c of cases) {
      const s = new Session([[c.name, c.factory]], true);
      for (let i = 0; i < 13; i++) {
        await s.stretch(c.name, c.goals[i % c.goals.length]!, blockSeed(`horizon-live-${c.name}-${i}`, i));
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
      await live.stretch(c.name, c.goals[0]!, blockSeed(`horizon-serve-${c.name}`, 99));
      const fin = live.finish();
      expect(fin.violations, `${c.name} wrap serve ${fin.violations.join("; ")}`).toEqual([]);
      expect(fin.turns, `${c.name} wrap serve turns=${fin.turns} (want 1)`).toBe(1);
    }
  }, 60_000);

  test("poll / saga / topk goLive PASS with a certified program — FAIL loudly, never skip-as-win", async () => {
    const cases: Array<{
      name: string;
      factory: () => World;
      goals: Array<Record<string, unknown>>;
    }> = [
      { name: "k8s-rollout", factory: createK8sRollout, goals: [...DEPLOY_IDS].map((deploy) => ({ deploy })) },
      { name: "saga-hold", factory: createSagaHold, goals: [...HOLD_IDS].map((holdId) => ({ holdId })) },
      { name: "search-rank", factory: createSearchRank, goals: [...QUERY_IDS].map((q) => ({ q })) },
    ];
    for (const c of cases) {
      const s = new Session([[c.name, c.factory]], true);
      for (let i = 0; i < 13; i++) {
        await s.stretch(c.name, c.goals[i % c.goals.length]!, blockSeed(`horizon-live-${c.name}-${i}`, i));
      }
      const r = await s.goLive(c.name, {
        compile: 9,
        holdout: 3,
        sandbox: c.factory,
        maxGram: 26,
      });
      expect(r.verdict, `${c.name} goLive ${r.verdict}: ${r.reasons.join("; ")} — not a skip-as-win`).toBe("PASS");
      expect(r.program, `${c.name} program`).not.toBeNull();
      expect(r.program!.manifest?.certified).toBe(true);
      const live = new Session([[c.name, c.factory]], true);
      live.addPrograms([r.program!]);
      await live.stretch(c.name, c.goals[0]!, blockSeed(`horizon-serve-${c.name}`, 99));
      const fin = live.finish();
      expect(fin.violations, `${c.name} wrap serve ${fin.violations.join("; ")}`).toEqual([]);
      expect(fin.turns, `${c.name} wrap serve turns=${fin.turns} (want 1)`).toBe(1);
    }
  }, 60_000);
});
