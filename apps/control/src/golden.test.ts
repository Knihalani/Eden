import { describe, expect, test } from "bun:test";
import { Store } from "./store";
import { createHandler } from "./server";
import { compileTraces } from "@eden/compile";
import { shadowProgram } from "@eden/shadow";
import { registryFrom } from "@eden/runtime";
import { createState, wrapTools, steerToolCalls, codingRegistry } from "@eden/wrap";
import {
  createTicketShip,
  runNaive,
  ticketShipProgram,
  underdeterminedSiblingTraces,
  OOD_ID,
  WITNESS_IDS,
} from "../../../packages/runtime/src/ticketship";
import type { StretchTrace } from "@eden/ir";

async function naiveTraces(n: number, skip = 0.2): Promise<StretchTrace[]> {
  const out: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const world = createTicketShip({ llmMs: 0 });
    const id = WITNESS_IDS[i % 3]!;
      const run = await runNaive(world, id, { skipVerifyP: i % 5 === 0 ? 1 : 0, seed: 7 + i });
    out.push({
      id: `g${i}`,
      events: run.events,
      input: { id },
      output: run.output,
      llmCalls: run.stats.llmCalls,
      duration_ms: 200 * run.stats.llmCalls,
      cost_cents: run.stats.cost_cents,
      skipped: run.stats.skipped,
      complete: run.stats.complete,
    });
  }
  return out;
}

describe("control plane", () => {
  test("empty inbox does not 500", async () => {
    const store = new Store(":memory:");
    const fetchHandler = createHandler({ store });
    const inbox = await fetchHandler(new Request("http://x/v1/inbox"));
    expect(inbox.status).toBe(200);
    const health = await fetchHandler(new Request("http://x/health"));
    const hj = (await health.json()) as { ok: boolean; traces?: number; registry?: boolean; island?: boolean };
    expect(hj.ok).toBe(true);
    expect(typeof hj.traces).toBe("number");
    const page = await fetchHandler(new Request("http://x/"));
    expect(page.status).toBe(404);
    const live = await fetchHandler(new Request("http://x/live"));
    expect(live.status).toBe(404);
    expect(hj.registry).toBe(false);
    expect(hj.island).toBe(false);
    const opt = await fetchHandler(new Request("http://x/v1/tools", { method: "OPTIONS" }));
    expect(opt.status).toBe(204);
    const badJson = await fetchHandler(
      new Request("http://x/v1/traces", { method: "POST", headers: { authorization: "Bearer eden_dev", "content-type": "application/json" }, body: "{" }),
    );
    expect(badJson.status).toBe(400);
    const cands = await fetchHandler(new Request("http://x/v1/candidates", { headers: { authorization: "Bearer eden_dev" } }));
    expect(cands.status).toBe(200);
    const locked = createHandler({ store, token: "secret-token" });
    const toolsNoAuth = await locked(new Request("http://x/v1/tools"));
    expect(toolsNoAuth.status).toBe(401);
    const statsNoAuth = await locked(new Request("http://x/v1/stats"));
    expect(statsNoAuth.status).toBe(401);
    const alias = await locked(
      new Request("http://x/v1/compile", { method: "POST", headers: { authorization: "Bearer eden_dev" }, body: "{}" }),
    );
    expect(alias.status).toBe(401);
    const ok = await locked(
      new Request("http://x/v1/compile", { method: "POST", headers: { authorization: "Bearer secret-token" }, body: "{}" }),
    );
    expect(ok.status).toBe(200);
    const tracesNoAuth = await locked(new Request("http://x/v1/traces"));
    expect(tracesNoAuth.status).toBe(401);
    const tracesOk = await locked(new Request("http://x/v1/traces", { headers: { authorization: "Bearer secret-token" } }));
    expect(tracesOk.status).toBe(200);
    const tracesBody = (await tracesOk.json()) as { traces: unknown[] };
    expect(Array.isArray(tracesBody.traces)).toBe(true);
  });

  test("inbox shows refusal of under-determined sibling", async () => {
    const store = new Store(":memory:");
    for (const t of underdeterminedSiblingTraces(3)) store.putTrace(t);
    const fetchHandler = createHandler({ store, token: "eden_dev" });
    const compiled = await fetchHandler(
      new Request("http://x/v1/compile", { method: "POST", headers: { authorization: "Bearer eden_dev" }, body: "{}" }),
    );
    expect(compiled.status).toBe(200);
    const inbox = await (await fetchHandler(new Request("http://x/v1/inbox"))).json() as { candidates: Array<{ id: string; refusal?: { reason: string } }> };
    expect(inbox.candidates.some((c) => c.refusal?.reason)).toBe(true);
    const page = await fetchHandler(new Request("http://x/"));
    expect(page.status).toBe(404);
    const again = await fetchHandler(
      new Request("http://x/v1/compile", { method: "POST", headers: { authorization: "Bearer eden_dev" }, body: "{}" }),
    );
    expect(again.status).toBe(200);
    const inbox2 = await (await fetchHandler(new Request("http://x/v1/inbox"))).json() as { candidates: Array<{ id: string }> };
    expect(inbox2.candidates[0]?.id).toBe(inbox.candidates[0]?.id);
  });
});

describe("TicketShip golden", () => {
  test("compile + shadow + approve + wrap 5x gates, steer, ood, fail-open", async () => {
    const traces = await naiveTraces(10, 0.2);
    const { programs, refusals } = compileTraces(traces);
    expect(refusals).toEqual([]);
    const program = programs[0]!;
    expect(program.steps.some((s) => s.kind === "tool" && s.tool === "verifyWrite")).toBe(true);
    const world = createTicketShip({ llmMs: 0 });
    const sh = await shadowProgram(program, traces, { registry: registryFrom(world.tools), island: world.island });
    expect(sh.verdict).toBe("PASS");
    program.manifest = sh.manifest;

    const store = new Store(":memory:");
    for (const t of traces) store.putTrace(t);
    store.putCandidate({
      id: program.id,
      sequence: program.sequence ?? [],
      program,
      refusal: null,
      verdict: "PASS",
      manifest: sh.manifest,
      created_at: Date.now(),
    });
    const fetchHandler = createHandler({ store, token: "eden_dev", registry: registryFrom(world.tools), island: world.island });
    const approved = await fetchHandler(
      new Request(`http://x/v1/tools/${program.id}/approve`, {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(approved.status).toBe(200);
    expect(store.candidate(program.id)).toBeUndefined();

    const liveWorld = createTicketShip({ llmMs: 200 });
    const naiveWorld = createTicketShip({ llmMs: 200 });
    const naive = await runNaive(naiveWorld, "T-100", { skipVerifyP: 0, seed: 1 });
    const state = createState({ programs: store.livePrograms(), island: liveWorld.island, llmCents: 1 });
    const tools = wrapTools(liveWorld.tools, state);
    const compiled = await tools[program.name]!.execute({ id: "T-100" });
    expect(compiled).toEqual({ notified: true, id: "T-100" });
    expect(state.receipts[0]!.llmCalls).toBeLessThanOrEqual(naive.stats.llmCalls / 5);
    expect(state.receipts[0]!.ms).toBeLessThanOrEqual(naive.stats.duration_ms / 5);
    expect(state.receipts[0]!.cents).toBeLessThanOrEqual(naive.stats.cost_cents / 5);
    expect(liveWorld.verified.has("T-100")).toBe(true);
    expect(naive.stats.llmCalls).toBe(8);

    const steered = steerToolCalls(
      [{ function: { name: "lookupTicket", arguments: "{\"id\":\"T-101\"}" } }],
      store.livePrograms(),
    );
    expect(steered[0]!.function?.name).toBe(program.name);

    const oodWorld = createTicketShip({ llmMs: 0 });
    const oodState = createState({ programs: store.livePrograms(), island: oodWorld.island, failOpen: true });
    const oodTools = wrapTools(oodWorld.tools, oodState);
    await oodTools.lookupTicket!.execute({ id: OOD_ID });
    expect(oodWorld.mutationsFor(OOD_ID).wrote).toBe(false);

    const server = Bun.serve({ port: 0, fetch: fetchHandler });
    const health = await fetch(`${server.url}health`);
    expect(health.ok).toBe(true);
    server.stop();
    const after = createState({ failOpen: true });
    const still = wrapTools(createTicketShip({ llmMs: 0 }).tools, after);
    const ping = await still.lookupTicket!.execute({ id: "T-100" });
    expect((ping as { id: string }).id).toBe("T-100");

    const rec = await fetchHandler(
      new Request("http://x/v1/receipts", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ toolId: program.id, version: program.version, ms: 10, llmCalls: 1, cents: 1, ok: true }),
      }),
    );
    expect(rec.status).toBe(200);
    expect(store.receipts().length).toBeGreaterThan(0);

    const paused = await fetchHandler(
      new Request(`http://x/v1/tools/${program.id}/pause`, {
        method: "POST",
        headers: { authorization: "Bearer eden_dev" },
        body: "{}",
      }),
    );
    expect(paused.status).toBe(200);
    expect(store.tool(program.id)?.state).toBe("paused");
    const rolled = await fetchHandler(
      new Request(`http://x/v1/tools/${program.id}/rollback`, {
        method: "POST",
        headers: { authorization: "Bearer eden_dev" },
        body: "{}",
      }),
    );
    expect(rolled.status).toBe(409);
    expect(store.tool(program.id)?.state).toBe("paused");
  });

  test("INCONCLUSIVE cannot be approved", async () => {
    const store = new Store(":memory:");
    const program = ticketShipProgram();
    store.putCandidate({
      id: program.id,
      sequence: program.sequence ?? [],
      program,
      refusal: null,
      verdict: "INCONCLUSIVE",
      manifest: null,
      created_at: Date.now(),
    });
    const fetchHandler = createHandler({ store, token: "eden_dev" });
    const approved = await fetchHandler(
      new Request(`http://x/v1/tools/${program.id}/approve`, {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(approved.status).toBe(409);
    const body = (await approved.json()) as { error: string };
    expect(body.error).toMatch(/INCONCLUSIVE/);
  });

  test("POST traces auto-compiles once there are three repeats", async () => {
    const store = new Store(":memory:");
    const fetchHandler = createHandler({ store, token: "eden_dev" });
    const traces = await naiveTraces(3, 0);
    const res = await fetchHandler(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ traces }),
      }),
    );
    expect(res.status).toBe(200);
    const inbox = (await (await fetchHandler(new Request("http://x/v1/inbox"))).json()) as { candidates: unknown[] };
    expect(inbox.candidates.length).toBeGreaterThanOrEqual(1);
    const again = await fetchHandler(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ traces }),
      }),
    );
    expect(again.status).toBe(200);
    expect(store.compiledCount()).toBe(store.traces().length);
  });

  test("no-repetition compiles nothing", async () => {
    const store = new Store(":memory:");
    for (let i = 0; i < 5; i++) {
      store.putTrace({
        id: `n${i}`,
        llmCalls: 3,
        duration_ms: 10,
        cost_cents: 3,
        input: { id: `z${i}` },
        events: [
          { name: `a${i}`, args: {}, result: {}, ok: true },
          { name: `b${i}`, args: {}, result: {}, ok: true },
          { name: `c${i}`, args: {}, result: {}, ok: true },
        ],
      });
    }
    const fetchHandler = createHandler({ store, token: "eden_dev" });
    await fetchHandler(new Request("http://x/v1/compile", { method: "POST", headers: { authorization: "Bearer eden_dev" }, body: "{}" }));
    const inbox = (await (await fetchHandler(new Request("http://x/v1/inbox"))).json()) as { candidates: unknown[] };
    expect(inbox.candidates).toEqual([]);
  });

  test("forged PASS shadow is ignored; server re-runs shadow", async () => {
    const traces = await naiveTraces(6, 0);
    const store = new Store(":memory:");
    for (const t of traces) store.putTrace(t);
    const program = ticketShipProgram();
    store.putCandidate({
      id: program.id,
      sequence: program.sequence ?? [],
      program,
      refusal: null,
      verdict: "pending",
      manifest: null,
      created_at: Date.now(),
    });
    const world = createTicketShip({ llmMs: 0 });
    const fetchHandler = createHandler({
      store,
      token: "eden_dev",
      registry: registryFrom(world.tools),
      island: world.island,
    });
    const forged = await fetchHandler(
      new Request(`http://x/v1/candidates/${program.id}/shadow`, {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ verdict: "PASS", manifest: { llmReduction: 99, latencyReduction: 99, costReduction: 99, skipRateBefore: 0, skipRateAfter: 0, nShadow: 99 } }),
      }),
    );
    expect(forged.status).toBe(200);
    const body = (await forged.json()) as { verdict: string };
    expect(body.verdict).toBe("PASS");
    expect(store.candidate(program.id)?.verdict).toBe("PASS");
    expect(store.candidate(program.id)?.manifest?.nShadow).toBeGreaterThanOrEqual(3);
    expect(store.candidate(program.id)?.manifest?.nShadow).not.toBe(99);
  });

  test("wrap-run executes a live program and GET program returns it", async () => {
    const traces = await naiveTraces(6, 0);
    const { programs } = compileTraces(traces);
    const program = programs[0]!;
    const world = createTicketShip({ llmMs: 0 });
    const sh = await shadowProgram(program, traces, { registry: registryFrom(world.tools), island: world.island });
    program.manifest = sh.manifest;
    const store = new Store(":memory:");
    store.putCandidate({
      id: program.id,
      sequence: program.sequence ?? [],
      program,
      refusal: null,
      verdict: "PASS",
      manifest: sh.manifest,
      created_at: Date.now(),
    });
    const fetchHandler = createHandler({
      store,
      token: "eden_dev",
      registry: registryFrom(world.tools),
      island: world.island,
    });
    const approved = await fetchHandler(
      new Request(`http://x/v1/tools/${program.id}/approve`, {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(approved.status).toBe(200);
    const got = await fetchHandler(new Request(`http://x/v1/tools/${program.id}/program`, { headers: { authorization: "Bearer eden_dev" } }));
    expect(got.status).toBe(200);
    const rec = await fetchHandler(new Request(`http://x/v1/tools/${program.id}`, { headers: { authorization: "Bearer eden_dev" } }));
    expect(rec.status).toBe(200);
    expect(((await rec.json()) as { state: string }).state).toBe("live");
    const liveProg = (await got.json()) as { name: string };
    expect(liveProg.name).toBe(program.name);
    const run = await fetchHandler(
      new Request("http://x/v1/wrap-run", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ toolId: program.id, input: { id: "T-100" } }),
      }),
    );
    expect(run.status).toBe(200);
    const out = (await run.json()) as { value: { notified: boolean } };
    expect(out.value.notified).toBe(true);
    expect(world.verified.has("T-100")).toBe(true);
    const oodRun = await fetchHandler(
      new Request("http://x/v1/wrap-run", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ toolId: program.id, input: { id: OOD_ID } }),
      }),
    );
    expect(oodRun.status).toBe(409);
    const oodBody = (await oodRun.json()) as { deopt?: boolean; program?: string; early?: boolean };
    expect(oodBody.deopt).toBe(true);
    expect(oodBody.early).toBe(true);
    expect(oodBody.program).toBe(program.name);
    expect(store.receipts().some((r) => r.ok === 0)).toBe(true);
    const timed = await fetchHandler(
      new Request("http://x/v1/wrap-run?timeout=5000", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ toolId: program.id, input: { id: "T-101" } }),
      }),
    );
    expect(timed.status).toBe(200);
    const recs = await fetchHandler(new Request("http://x/v1/receipts", { headers: { authorization: "Bearer eden_dev" } }));
    expect(recs.status).toBe(200);
    const recBody = (await recs.json()) as { receipts: Array<{ ok: number }> };
    expect(recBody.receipts.length).toBeGreaterThan(0);
    const liveOnly = await fetchHandler(new Request("http://x/v1/tools?state=live", { headers: { authorization: "Bearer eden_dev" } }));
    expect(((await liveOnly.json()) as { tools: unknown[] }).tools.length).toBe(1);
    expect(store.receiptStats(program.id).fail).toBeGreaterThan(0);
    const paused = await fetchHandler(
      new Request(`http://x/v1/tools/${program.id}/pause`, {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(paused.status).toBe(200);
    const pausedRun = await fetchHandler(
      new Request("http://x/v1/wrap-run", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ toolId: program.id, input: { id: "T-102" } }),
      }),
    );
    expect(pausedRun.status).toBe(409);
    expect(((await pausedRun.json()) as { error?: string }).error).toBe("paused");
    const resumed = await fetchHandler(
      new Request(`http://x/v1/tools/${program.id}/resume`, {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(resumed.status).toBe(200);
    const afterResume = await fetchHandler(
      new Request("http://x/v1/wrap-run", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ toolId: program.id, input: { id: "T-102" } }),
      }),
    );
    expect(afterResume.status).toBe(200);
  });

  test("duplicate traces do not inflate support", async () => {
    const store = new Store(":memory:");
    const traces = await naiveTraces(3, 0);
    expect(store.putTrace(traces[0]!)).toBe(true);
    expect(store.putTrace({ ...traces[0]!, id: "copy" })).toBe(false);
    expect(store.traces().length).toBe(1);
    const fetchHandler = createHandler({ store, token: "eden_dev" });
    const res = await fetchHandler(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ traces }),
      }),
    );
    const body = (await res.json()) as { accepted: number; duplicates: number };
    expect(body.accepted).toBe(2);
    expect(body.duplicates).toBe(1);
    expect(store.traces().length).toBe(3);
    const inbox = (await (await fetchHandler(new Request("http://x/v1/inbox"))).json()) as { sig: string };
    expect(inbox.sig.length).toBeGreaterThan(0);
    const savings = await fetchHandler(new Request("http://x/v1/savings", { headers: { authorization: "Bearer eden_dev" } }));
    expect(savings.status).toBe(200);
    expect(await savings.json()).toEqual({ runs: 0, fail: 0, llmReductionMean: 0, live: 0 });
  });

  test("EDEN_AUTO_APPROVE ships PASS candidates after compile", async () => {
    process.env.EDEN_AUTO_APPROVE = "1";
    try {
      const traces = await naiveTraces(10, 0);
      const store = new Store(":memory:");
      const world = createTicketShip({ llmMs: 0 });
      const fetchHandler = createHandler({
        store,
        token: "eden_dev",
        registry: registryFrom(world.tools),
        island: world.island,
      });
      const res = await fetchHandler(
        new Request("http://x/v1/compile", {
          method: "POST",
          headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(res.status).toBe(200);
      for (const t of traces) store.putTrace(t);
      const compiled = await fetchHandler(
        new Request("http://x/v1/compile", {
          method: "POST",
          headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
          body: "{}",
        }),
      );
      const body = (await compiled.json()) as { shipped?: number; programs?: number };
      expect(compiled.status).toBe(200);
      expect(body.shipped).toBeGreaterThanOrEqual(1);
      expect(store.liveCount()).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.EDEN_AUTO_APPROVE;
    }
  });

  test("concurrent trace posts compile under a single flight", async () => {
    const store = new Store(":memory:");
    const fetchHandler = createHandler({ store, token: "eden_dev" });
    const traces = await naiveTraces(3, 0);
    const req = () =>
      fetchHandler(
        new Request("http://x/v1/traces", {
          method: "POST",
          headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
          body: JSON.stringify({ traces }),
        }),
      );
    const [a, b] = await Promise.all([req(), req()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(store.traces().length).toBe(3);
    expect(store.compiledCount()).toBe(3);
  });

  test("uncovered tools stay pending with a reason and do not ship", async () => {
    const traces = await naiveTraces(6, 0);
    const store = new Store(":memory:");
    for (const t of traces) store.putTrace(t);
    const fetchHandler = createHandler({ store, token: "eden_dev", registry: codingRegistry() });
    await fetchHandler(
      new Request("http://x/v1/compile", { method: "POST", headers: { authorization: "Bearer eden_dev" }, body: "{}" }),
    );
    const inbox = (await (await fetchHandler(new Request("http://x/v1/inbox"))).json()) as {
      candidates: Array<{ id: string; program: unknown; verdict: string; refusal: { reason: string } | null }>;
    };
    const c = inbox.candidates.find((x) => x.program);
    expect(c).toBeTruthy();
    expect(c!.verdict).toBe("pending");
    expect(c!.refusal?.reason).toMatch(/^uncovered:/);
    const approve = await fetchHandler(
      new Request(`http://x/v1/tools/${c!.id}/approve`, {
        method: "POST",
        headers: { authorization: "Bearer eden_dev" },
        body: "{}",
      }),
    );
    expect(approve.status).toBe(409);
    const err = (await approve.json()) as { error: string };
    expect(err.error).toMatch(/uncovered:/);
  });

  test("empty edits object ships without a registry", async () => {
    const program = ticketShipProgram();
    const manifest = {
      llmReduction: 5,
      latencyReduction: 2,
      costReduction: 2,
      skipRateBefore: 0.1,
      skipRateAfter: 0,
      nShadow: 6,
    };
    program.manifest = manifest;
    const store = new Store(":memory:");
    store.putCandidate({
      id: "c1",
      sequence: program.sequence ?? [],
      program,
      refusal: null,
      verdict: "PASS",
      manifest,
      created_at: Date.now(),
    });
    const fetchHandler = createHandler({ store, token: "eden_dev" });
    const approved = await fetchHandler(
      new Request("http://x/v1/tools/c1/approve", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ edits: { name: undefined, drop: undefined } }),
      }),
    );
    expect(approved.status).toBe(200);
    expect(store.tool(program.id)?.state).toBe("live");
  });

  test("name-only edit ships without a registry", async () => {
    const program = ticketShipProgram();
    const manifest = {
      llmReduction: 5,
      latencyReduction: 2,
      costReduction: 2,
      skipRateBefore: 0.1,
      skipRateAfter: 0,
      nShadow: 6,
    };
    program.manifest = manifest;
    const store = new Store(":memory:");
    store.putCandidate({
      id: "c2",
      sequence: program.sequence ?? [],
      program,
      refusal: null,
      verdict: "PASS",
      manifest,
      created_at: Date.now(),
    });
    const fetchHandler = createHandler({ store, token: "eden_dev" });
    const approved = await fetchHandler(
      new Request("http://x/v1/tools/c2/approve", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ edits: { name: "shipped_ticket" } }),
      }),
    );
    expect(approved.status).toBe(200);
    expect(store.tool(program.id)?.name).toBe("shipped_ticket");
  });

  test("structural drop without registry is refused", async () => {
    const program = ticketShipProgram();
    const manifest = {
      llmReduction: 5,
      latencyReduction: 2,
      costReduction: 2,
      skipRateBefore: 0.1,
      skipRateAfter: 0,
      nShadow: 6,
    };
    program.manifest = manifest;
    const store = new Store(":memory:");
    store.putCandidate({
      id: "c3",
      sequence: program.sequence ?? [],
      program,
      refusal: null,
      verdict: "PASS",
      manifest,
      created_at: Date.now(),
    });
    const fetchHandler = createHandler({ store, token: "eden_dev" });
    const approved = await fetchHandler(
      new Request("http://x/v1/tools/c3/approve", {
        method: "POST",
        headers: { authorization: "Bearer eden_dev", "content-type": "application/json" },
        body: JSON.stringify({ edits: { drop: ["lookup"] } }),
      }),
    );
    expect(approved.status).toBe(409);
  });

  test("inbox lists paused tools with receipt stats", async () => {
    const program = ticketShipProgram();
    const store = new Store(":memory:");
    store.putTool({
      id: "t1",
      name: "paused_one",
      version: "1",
      program,
      state: "paused",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    store.putReceipt({ tool_id: "t1", version: "1", ms: 40, llm_calls: 0, cents: 0.1, ok: 1 });
    const fetchHandler = createHandler({ store, token: "eden_dev" });
    const inbox = (await (await fetchHandler(new Request("http://x/v1/inbox"))).json()) as {
      live: Array<{ id: string; state: string; stats: { n: number } }>;
    };
    expect(inbox.live.some((t) => t.id === "t1" && t.state === "paused")).toBe(true);
    expect(inbox.live.find((t) => t.id === "t1")?.stats.n).toBe(1);
  });
});
