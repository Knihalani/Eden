import { afterAll, describe, expect, test } from "bun:test";
import { Store } from "./store";
import { createHandler } from "./server";
import { useTempEdenHome } from "./test-home";
import { maybeQueueRefresh, refreshCandidateId, REFRESH_WAITING_COPY, isRefreshCandidate } from "./refresh";
import { replayRegistry } from "@eden/shadow";
import { createTicketShip, runNaive, toNaiveTrace, WITNESS_IDS } from "../../../packages/runtime/src/ticketship";
import type { StretchTrace } from "@eden/ir";

useTempEdenHome();

const PREV_DEV = process.env.EDEN_DEV;
process.env.EDEN_DEV = "1";
afterAll(() => {
  process.env.EDEN_DEV = PREV_DEV;
});

async function naiveTraces(n: number): Promise<StretchTrace[]> {
  const out: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const world = createTicketShip({ llmMs: 0 });
    const id = WITNESS_IDS[i % 3]!;
    const run = await runNaive(world, id, { skipVerifyP: 0, seed: 7 + i });
    const base = toNaiveTrace(`g${i}`, id, run);
    const events = base.events.map((e) => ({ ...e, duration_ms: e.name === "draftReply" ? 5000 : 100 }));
    out.push({ ...base, duration_ms: events.reduce((a, e) => a + (e.duration_ms ?? 0), 0), events });
  }
  return out;
}

function auth(path: string, init?: RequestInit): Request {
  return new Request(`http://x${path}`, {
    ...init,
    headers: { authorization: "Bearer eden_dev", ...(init?.headers ?? {}) },
  });
}

describe("control-plane drift refresh", () => {
  test("two deopts queue a replacement candidate; live stays live; copy is the Approve sentence", async () => {
    const traces = await naiveTraces(6);
    const store = new Store(":memory:");
    const fetchHandler = createHandler({
      store,
      token: "eden_dev",
      sandboxFor: (t) => replayRegistry(undefined, t),
      island: createTicketShip({ llmMs: 0 }).island,
    });
    await fetchHandler(auth("/v1/traces", { method: "POST", body: JSON.stringify({ traces }) }));
    const inbox = (await (await fetchHandler(auth("/v1/inbox"))).json()) as {
      candidates: Array<{ id: string; verdict: string; program: { id: string } | null }>;
    };
    const pass = inbox.candidates.find((c) => c.verdict === "PASS" && c.program);
    expect(pass).toBeTruthy();
    const approved = await fetchHandler(auth(`/v1/tools/${pass!.id}/approve`, { method: "POST", body: "{}" }));
    expect(approved.status).toBe(200);
    const liveId = pass!.id;

    store.putReceipt({
      tool_id: liveId,
      version: store.tool(liveId)!.version,
      ms: 10,
      llm_calls: 0,
      cents: 0,
      ok: 0,
      payload: JSON.stringify({ outcome: "deopt", deoptReason: "envelope" }),
    });
    const first = await maybeQueueRefresh(
      { store, sandboxFor: (t) => replayRegistry(undefined, t), island: createTicketShip({ llmMs: 0 }).island },
      liveId,
    );
    expect(first).toBe("below-threshold");

    store.putReceipt({
      tool_id: liveId,
      version: store.tool(liveId)!.version,
      ms: 10,
      llm_calls: 0,
      cents: 0,
      ok: 0,
      payload: JSON.stringify({ outcome: "deopt", deoptReason: "envelope" }),
    });
    const queued = await maybeQueueRefresh(
      { store, sandboxFor: (t) => replayRegistry(undefined, t), island: createTicketShip({ llmMs: 0 }).island },
      liveId,
    );
    expect(queued).toBe("queued");
    const cand = store.candidate(refreshCandidateId(liveId));
    expect(cand?.verdict).toBe("PASS");
    expect(cand?.program?.id).toBe(liveId);
    expect(cand?.program?.description).toBe(REFRESH_WAITING_COPY);
    expect(store.tool(liveId)?.state).toBe("live");

    const pending = await maybeQueueRefresh({ store, sandboxFor: (t) => replayRegistry(undefined, t) }, liveId);
    expect(pending).toBe("pending");
  });

  test("early deopts do not count toward the refresh threshold", async () => {
    const store = new Store(":memory:");
    store.putTool({
      id: "tool_early",
      name: "early",
      version: "v1",
      program: {
        id: "tool_early",
        version: "v1",
        name: "early",
        description: "",
        inputSchema: { type: "object" },
        steps: [],
        returns: { kind: "literal", value: null },
        contract: { witnesses: 0, minLlmReduction: 2, allowExact: false },
        manifest: null,
        sequence: ["lookup"],
      },
      state: "live",
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    store.putReceipt({
      tool_id: "tool_early",
      version: "v1",
      ms: 1,
      llm_calls: 0,
      cents: 0,
      ok: 0,
      payload: JSON.stringify({ outcome: "deopt", early: true, deoptReason: "replay-safe" }),
    });
    store.putReceipt({
      tool_id: "tool_early",
      version: "v1",
      ms: 1,
      llm_calls: 0,
      cents: 0,
      ok: 0,
      payload: JSON.stringify({ outcome: "deopt", early: true, deoptReason: "replay-safe" }),
    });
    const out = await maybeQueueRefresh({ store }, "tool_early");
    expect(out).toBe("below-threshold");
    expect(store.candidate(refreshCandidateId("tool_early"))).toBeUndefined();
  });

  test("compile does not wipe a queued refresh; auto-approve skips it", async () => {
    const traces = await naiveTraces(6);
    const store = new Store(":memory:");
    const fetchHandler = createHandler({
      store,
      token: "eden_dev",
      sandboxFor: (t) => replayRegistry(undefined, t),
      island: createTicketShip({ llmMs: 0 }).island,
    });
    await fetchHandler(auth("/v1/traces", { method: "POST", body: JSON.stringify({ traces }) }));
    const inbox = (await (await fetchHandler(auth("/v1/inbox"))).json()) as {
      candidates: Array<{ id: string; verdict: string; program: { id: string } | null }>;
    };
    const pass = inbox.candidates.find((c) => c.verdict === "PASS" && c.program)!;
    await fetchHandler(auth(`/v1/tools/${pass.id}/approve`, { method: "POST", body: "{}" }));
    store.putReceipt({
      tool_id: pass.id,
      version: store.tool(pass.id)!.version,
      ms: 10,
      llm_calls: 0,
      cents: 0,
      ok: 0,
      payload: JSON.stringify({ outcome: "deopt", deoptReason: "envelope" }),
    });
    store.putReceipt({
      tool_id: pass.id,
      version: store.tool(pass.id)!.version,
      ms: 10,
      llm_calls: 0,
      cents: 0,
      ok: 0,
      payload: JSON.stringify({ outcome: "deopt", deoptReason: "envelope" }),
    });
    expect(
      await maybeQueueRefresh(
        { store, sandboxFor: (t) => replayRegistry(undefined, t), island: createTicketShip({ llmMs: 0 }).island },
        pass.id,
      ),
    ).toBe("queued");

    const prev = process.env.EDEN_AUTO_APPROVE;
    process.env.EDEN_AUTO_APPROVE = "1";
    try {
      await fetchHandler(auth("/v1/compile", { method: "POST", body: "{}" }));
    } finally {
      if (prev === undefined) delete process.env.EDEN_AUTO_APPROVE;
      else process.env.EDEN_AUTO_APPROVE = prev;
    }
    const kept = store.candidate(refreshCandidateId(pass.id));
    expect(kept).toBeTruthy();
    expect(isRefreshCandidate(kept!.id)).toBe(true);
    expect(store.tool(pass.id)?.state).toBe("live");
  });

  test("GET /v1/tools/:id names the refresh candidate", async () => {
    const traces = await naiveTraces(6);
    const store = new Store(":memory:");
    const fetchHandler = createHandler({
      store,
      token: "eden_dev",
      sandboxFor: (t) => replayRegistry(undefined, t),
      island: createTicketShip({ llmMs: 0 }).island,
    });
    await fetchHandler(auth("/v1/traces", { method: "POST", body: JSON.stringify({ traces }) }));
    const inbox = (await (await fetchHandler(auth("/v1/inbox"))).json()) as {
      candidates: Array<{ id: string; verdict: string; program: { id: string } | null }>;
    };
    const pass = inbox.candidates.find((c) => c.verdict === "PASS" && c.program)!;
    await fetchHandler(auth(`/v1/tools/${pass.id}/approve`, { method: "POST", body: "{}" }));
    store.putReceipt({
      tool_id: pass.id,
      version: store.tool(pass.id)!.version,
      ms: 10,
      llm_calls: 0,
      cents: 0,
      ok: 0,
      payload: JSON.stringify({ outcome: "deopt", deoptReason: "envelope" }),
    });
    store.putReceipt({
      tool_id: pass.id,
      version: store.tool(pass.id)!.version,
      ms: 10,
      llm_calls: 0,
      cents: 0,
      ok: 0,
      payload: JSON.stringify({ outcome: "deopt", deoptReason: "envelope" }),
    });
    await maybeQueueRefresh(
      { store, sandboxFor: (t) => replayRegistry(undefined, t), island: createTicketShip({ llmMs: 0 }).island },
      pass.id,
    );
    const one = (await (await fetchHandler(auth(`/v1/tools/${pass.id}`))).json()) as {
      state: string;
      candidate: { id: string; verdict: string } | null;
    };
    expect(one.state).toBe("live");
    expect(one.candidate?.id).toBe(refreshCandidateId(pass.id));
    expect(one.candidate?.verdict).toBe("PASS");
  });
});
