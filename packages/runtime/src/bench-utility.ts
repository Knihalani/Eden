/**
 * Strongest honest proof for V1: compile noisy traces, shadow, approve,
 * then run the mined program through wrapTools (no OpenAI gateway).
 *
 * LLM time is simulated (Bun.sleep), tools are in-memory. Numbers are
 * wall-clock on this machine, not a billed provider.
 */
import { compileTraces } from "../../compile/src/index";
import { canApprove, shadowProgram } from "../../shadow/src/index";
import { createState, injectTools, steerToolCalls, wrapTools } from "../../wrap/src/index";
import { Store, createHandler } from "../../../apps/control/src/index";
import { registryFrom, runProgram } from "../src/index";
import {
  OOD_ID,
  WITNESS_IDS,
  createTicketShip,
  runNaive,
  ticketShipProgram,
} from "../src/ticketship";
import type { StretchTrace } from "@eden/ir";

const LLM_MS = Number(process.env.LLM_MS || 200);
const TRACE_N = Number(process.env.TRACE_N || 40);
const HOT_N = Number(process.env.HOT_N || 8);

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}

function summarize(xs: number[]) {
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    sum: Math.round(sum),
    mean: xs.length ? Math.round(sum / xs.length) : 0,
    p50: Math.round(pct(xs, 50)),
    p95: Math.round(pct(xs, 95)),
  };
}

async function collectTraces(n: number, llmMs = 0): Promise<StretchTrace[]> {
  const out: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const world = createTicketShip({ llmMs });
    const id = WITNESS_IDS[i % WITNESS_IDS.length]!;
    const run = await runNaive(world, id, { skipVerifyP: 0.2, seed: 100 + i });
    out.push({
      id: `u${i}`,
      events: run.events,
      input: { id },
      llmCalls: run.stats.llmCalls,
      duration_ms: Math.max(run.stats.duration_ms, 200 * run.stats.llmCalls),
      cost_cents: run.stats.cost_cents,
      skipped: run.stats.skipped,
      complete: run.stats.complete,
    });
  }
  return out;
}

const tCollect0 = performance.now();
const traces = await collectTraces(TRACE_N, 0);
const collectMs = performance.now() - tCollect0;
const skipVerifyTraces = traces.filter((t) => t.skipped?.includes("verifyWrite")).length;

const tCompile0 = performance.now();
const mined = compileTraces(traces);
const compileMs = performance.now() - tCompile0;
const program = mined.programs[0];
if (!program) throw new Error("compiler minted 0 programs");

const shadowWorld = createTicketShip({ llmMs: 0 });
const tShadow0 = performance.now();
const shadow = await shadowProgram(program, traces, {
  registry: registryFrom(shadowWorld.tools),
  island: shadowWorld.island,
});
const shadowMs = performance.now() - tShadow0;
const live = { ...program, manifest: shadow.manifest };

const handwritten = ticketShipProgram();
const ids = Array.from({ length: HOT_N }, (_, i) => WITNESS_IDS[i % WITNESS_IDS.length]!);

const naiveLlm: number[] = [];
const naiveMs: number[] = [];
const naiveCents: number[] = [];
const naiveSkip: number[] = [];
const naiveVerify: boolean[] = [];
for (const id of ids) {
  const world = createTicketShip({ llmMs: LLM_MS });
  const t0 = performance.now();
  const run = await runNaive(world, id, { skipVerifyP: 0.2, seed: id.charCodeAt(3) });
  naiveMs.push(performance.now() - t0);
  naiveLlm.push(run.stats.llmCalls);
  naiveCents.push(run.stats.cost_cents);
  naiveSkip.push(run.stats.skipped.includes("verifyWrite") ? 1 : 0);
  naiveVerify.push(world.verified.has(id));
}

const wrapLlm: number[] = [];
const wrapMs: number[] = [];
const wrapCents: number[] = [];
const wrapVerify: boolean[] = [];
for (const id of ids) {
  const world = createTicketShip({ llmMs: LLM_MS });
  const state = createState({ programs: [live], island: world.island, llmCents: 1 });
  const tools = wrapTools(world.tools, state);
  const t0 = performance.now();
  await tools.lookupTicket.execute({ id });
  wrapMs.push(performance.now() - t0);
  wrapLlm.push(state.receipts.at(-1)?.llmCalls ?? 0);
  wrapCents.push(state.receipts.at(-1)?.cents ?? 0);
  wrapVerify.push(world.verified.has(id));
}

const minedRunLlm: number[] = [];
const minedRunMs: number[] = [];
for (const id of ids) {
  const world = createTicketShip({ llmMs: LLM_MS });
  const t0 = performance.now();
  const run = await runProgram(live, { id }, {
    registry: registryFrom(world.tools),
    island: world.island,
    llmCents: 1,
  });
  minedRunMs.push(performance.now() - t0);
  minedRunLlm.push(run.stats.llmCalls);
}

const hwWorld = createTicketShip({ llmMs: LLM_MS });
const hw0 = performance.now();
await runProgram(handwritten, { id: "T-100" }, {
  registry: registryFrom(hwWorld.tools),
  island: hwWorld.island,
  llmCents: 1,
});
const hwMs = performance.now() - hw0;

const oodWorld = createTicketShip({ llmMs: 0 });
const oodState = createState({ programs: [live], island: oodWorld.island, failOpen: true });
const oodTools = wrapTools(oodWorld.tools, oodState);
await oodTools.lookupTicket.execute({ id: OOD_ID });
const oodMut = oodWorld.mutationsFor(OOD_ID);
await oodTools.verifyWrite.execute({ id: OOD_ID });
const oodVerifySteered = oodWorld.verified.has(OOD_ID);

let steered = 0;
for (const id of WITNESS_IDS) {
  const out = steerToolCalls(
    [{ function: { name: "lookupTicket", arguments: JSON.stringify({ id }) } }],
    [live],
  );
  if (out[0]?.function?.name === live.name) steered++;
}
const oodSteer = steerToolCalls(
  [{ function: { name: "lookupTicket", arguments: JSON.stringify({ id: OOD_ID }) } }],
  [live],
);
const injected = injectTools(
  [{ type: "function", function: { name: "lookupTicket", parameters: {} } }],
  [live],
) as Array<{ function?: { name?: string } }>;

const nestedTraces: StretchTrace[] = Array.from({ length: 3 }, (_, i) => {
  const orgs = [`o${i}a`, `o${i}b`];
  return {
    id: `nest${i}`,
    llmCalls: 10,
    duration_ms: 100,
    cost_cents: 10,
    input: { q: "open" },
    complete: true,
    events: [
      { name: "listOrgs", args: { q: "open" }, result: { orgs }, ok: true },
      ...orgs.flatMap((org) => {
        const itemIds = [`${org}-1`, `${org}-2`];
        return [
          { name: "listItems", args: { id: org }, result: { ids: itemIds }, ok: true },
          ...itemIds.map((id) => ({ name: "getItem", args: { id }, result: { id, org }, ok: true })),
        ];
      }),
      { name: "notify", args: { q: "open" }, result: { notified: true }, ok: true },
    ],
  };
});
const nestedMined = compileTraces(nestedTraces);
const nestedProg = nestedMined.programs[0];
const nestedHasInner = Boolean(
  nestedProg?.steps.some((s) => s.kind === "loop" && s.body.some((id) => nestedProg.steps.some((x) => x.id === id && x.kind === "loop"))),
);
let nestedHits = 0;
if (nestedProg) {
  const registry = registryFrom({
    listOrgs: async () => ({ orgs: ["a", "b"] }),
    listItems: async (args) => ({ ids: [`${args.id}-1`, `${args.id}-2`] }),
    getItem: async () => {
      nestedHits++;
      return { ok: true };
    },
    notify: async () => ({ notified: true }),
  });
  await runProgram(
    { ...nestedProg, contract: { ...nestedProg.contract, allowExact: true } },
    { q: "open" },
    {
      registry,
      island: async () => ({ orgs: ["a", "b"] }),
    },
  );
}

const store = new Store(":memory:");
const planeWorld = createTicketShip({ llmMs: 0 });
const handler = createHandler({
  store,
  token: "eden_dev",
  registry: registryFrom(planeWorld.tools),
  island: planeWorld.island,
});
const auth = { authorization: "Bearer eden_dev", "content-type": "application/json" };
for (const t of traces.slice(0, 12)) {
  const r = await handler(new Request("http://x/v1/traces", { method: "POST", headers: auth, body: JSON.stringify(t) }));
  if (!r.ok) throw new Error(`trace post ${r.status}`);
}
const compiledHttp = await handler(new Request("http://x/v1/compile", { method: "POST", headers: auth, body: "{}" }));
const compiledBody = (await compiledHttp.json()) as { programs?: number };
const cands = await handler(new Request("http://x/v1/candidates", { headers: auth }));
const candBody = (await cands.json()) as { candidates: Array<{ id: string; verdict: string; program?: { id: string } }> };
const pass = candBody.candidates.find((c) => c.verdict === "PASS" && c.program);
if (!pass?.program) throw new Error("control plane minted no PASS candidate");
const approved = await handler(
  new Request(`http://x/v1/tools/${pass.id}/approve`, { method: "POST", headers: auth, body: "{}" }),
);
const wrapRunWorld = createTicketShip({ llmMs: LLM_MS });
const wrapRunHandler = createHandler({
  store,
  token: "eden_dev",
  registry: registryFrom(wrapRunWorld.tools),
  island: wrapRunWorld.island,
});
const wrapRun0 = performance.now();
const wrapRunRes = await wrapRunHandler(
  new Request("http://x/v1/wrap-run", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ toolId: pass.program.id, input: { id: "T-100" } }),
  }),
);
const wrapRunMs = performance.now() - wrapRun0;
const wrapRunJson = (await wrapRunRes.json()) as { value?: { notified?: boolean }; error?: string };
const oodRun = await wrapRunHandler(
  new Request("http://x/v1/wrap-run", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ toolId: pass.program.id, input: { id: OOD_ID } }),
  }),
);
const oodRunJson = (await oodRun.json()) as { deopt?: boolean; early?: boolean };

const naiveMeanLlm = naiveLlm.reduce((a, b) => a + b, 0) / naiveLlm.length;
const wrapMeanLlm = wrapLlm.reduce((a, b) => a + b, 0) / wrapLlm.length;
const naiveMeanMs = naiveMs.reduce((a, b) => a + b, 0) / naiveMs.length;
const wrapMeanMs = wrapMs.reduce((a, b) => a + b, 0) / wrapMs.length;
const naiveMeanCents = naiveCents.reduce((a, b) => a + b, 0) / naiveCents.length;
const wrapMeanCents = wrapCents.reduce((a, b) => a + b, 0) / wrapCents.length;

const report = {
  whatThisIs: "In-process V1 (no OpenAI gateway). LLM delay is Bun.sleep, not a billed model.",
  traces: {
    n: traces.length,
    collectMs: Math.round(collectMs),
    skipVerifyNoise: skipVerifyTraces,
    skipVerifyRate: Number((skipVerifyTraces / traces.length).toFixed(3)),
  },
  compiler: {
    ms: Math.round(compileMs),
    programs: mined.programs.length,
    refusals: mined.refusals.length,
    hasIsland: program.steps.some((s) => s.kind === "island"),
    hasVerify: program.steps.some((s) => s.kind === "tool" && s.tool === "verifyWrite"),
    sequence: program.sequence,
  },
  shadow: {
    ms: Math.round(shadowMs),
    verdict: shadow.verdict,
    canApprove: canApprove(shadow),
    manifest: shadow.manifest,
    reasons: shadow.reasons,
  },
  hot: {
    llmMs: LLM_MS,
    tickets: HOT_N,
    naive: { llm: summarize(naiveLlm), ms: summarize(naiveMs), cents: summarize(naiveCents), skipVerify: naiveSkip.reduce((a, b) => a + b, 0), verified: naiveVerify.filter(Boolean).length },
    wrapToolsMined: { llm: summarize(wrapLlm), ms: summarize(wrapMs), cents: summarize(wrapCents), verified: wrapVerify.filter(Boolean).length },
    runProgramMined: { llm: summarize(minedRunLlm), ms: summarize(minedRunMs) },
    handwrittenOneShotMs: Math.round(hwMs),
    reduction: {
      llm: Number((naiveMeanLlm / Math.max(wrapMeanLlm, 1e-9)).toFixed(2)),
      ms: Number((naiveMeanMs / Math.max(wrapMeanMs, 1e-9)).toFixed(2)),
      cents: Number((naiveMeanCents / Math.max(wrapMeanCents, 1e-9)).toFixed(2)),
    },
  },
  safety: {
    oodMutations: oodMut,
    oodDidNotSteerVerify: !oodVerifySteered,
    steerWitnesses: `${steered}/${WITNESS_IDS.length}`,
    oodNotSteered: oodSteer[0]?.function?.name === "lookupTicket",
    injectedCompiledFirst: injected[0]?.function?.name === live.name,
  },
  nested: {
    programs: nestedMined.programs.length,
    innerLoop: nestedHasInner,
    getItemHits: nestedHits,
    expectedHits: 4,
  },
  controlPlane: {
    compilePrograms: compiledBody.programs ?? 0,
    approved: approved.status === 200,
    candidateCleared: store.candidate(pass.id) == null,
    wrapRunMs: Math.round(wrapRunMs),
    wrapRunNotified: wrapRunJson.value?.notified === true,
    wrapRunVerified: wrapRunWorld.verified.has("T-100"),
    oodWrapRun: { status: oodRun.status, deopt: oodRunJson.deopt === true, early: oodRunJson.early === true },
  },
  gates: {
    programsExactly1: mined.programs.length === 1,
    shadowPass: shadow.verdict === "PASS" && canApprove(shadow),
    llm5x: naiveMeanLlm / wrapMeanLlm >= 5,
    ms5x: naiveMeanMs / wrapMeanMs >= 5,
    cents5x: naiveMeanCents / wrapMeanCents >= 5,
    verifyPinned: wrapVerify.every(Boolean) && wrapVerify.length === HOT_N,
    naiveCanSkip: skipVerifyTraces > 0,
    oodNoMutate: !oodMut.wrote && !oodMut.verified && !oodMut.notified,
    steer100: steered === WITNESS_IDS.length,
    nestedInner: nestedHasInner && nestedHits === 4,
    wrapRunLive: wrapRunRes.status === 200 && wrapRunWorld.verified.has("T-100"),
    oodDeopt: oodRun.status === 409 && oodRunJson.deopt === true,
  },
};

console.log(JSON.stringify(report, null, 2));
const failed = Object.entries(report.gates).filter(([, v]) => !v).map(([k]) => k);
if (failed.length) {
  console.error("GATES FAILED", failed);
  process.exit(1);
}
