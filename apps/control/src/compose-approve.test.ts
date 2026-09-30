import { afterAll, describe, expect, test } from "bun:test";
import { compileTraces, assertComposeNotLive } from "@eden/compile";
import type { StretchTrace } from "@eden/ir";
import { createHandler } from "./server";
import { Store } from "./store";

const PREV_DEV = process.env.EDEN_DEV;
process.env.EDEN_DEV = "1";
afterAll(() => {
  process.env.EDEN_DEV = PREV_DEV;
});

const passManifest = {
  llmReduction: 5,
  latencyReduction: 2,
  costReduction: 2,
  skipRateBefore: 0.1,
  skipRateAfter: 0,
  nShadow: 6,
  tokensMeasured: true,
  tokensSaved: 400,
  timeMeasured: false,
  timeSavedMs: null,
};

function concatTraces(n = 3): StretchTrace[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `T-${i}`;
    return {
      id: `join-${i}`,
      agentId: "desk",
      llmCalls: 6,
      duration_ms: 60,
      cost_cents: 6,
      complete: true,
      input: { id },
      output: { applied: true, id },
      events: [
        { name: "lookupTicket", args: { id }, result: { ok: true, id }, ok: true },
        { name: "fetchDetails", args: { id }, result: { id, body: "open" }, ok: true },
        { name: "classifyIssue", args: { id }, result: { class: "billing", id }, ok: true },
        { name: "fetchInvoice", args: { id }, result: { id, total: 40 }, ok: true },
        { name: "getBalance", args: { id }, result: { id, due: 40 }, ok: true },
        { name: "applyCredit", args: { id, amount: 40 }, result: { applied: true, id }, ok: true },
      ],
    };
  });
}

describe("same-agent compose approve gate", () => {
  test("POST /v1/tools/:id/approve turns a compose candidate On and never auto-On", async () => {
    const traces = concatTraces(3);
    const { programs } = compileTraces(traces);
    const program = programs.find((p) => p.origin?.mode === "compose");
    expect(program).toBeTruthy();
    expect(program!.manifest).toBeNull();
    expect(program!.composedOf).toHaveLength(2);
    assertComposeNotLive(program!);

    const store = new Store(":memory:");
    for (const t of traces) store.putTrace(t);
    store.putCandidate({
      id: program!.id,
      sequence: program!.sequence ?? [],
      program: program!,
      refusal: null,
      verdict: "PASS",
      manifest: passManifest,
      created_at: Date.now(),
    });
    expect(store.liveCount()).toBe(0);
    expect(store.tool(program!.id)).toBeUndefined();

    const fetchHandler = createHandler({ store, token: "eden_dev" });
    const auth = { authorization: "Bearer eden_dev", "content-type": "application/json" };

    const before = await fetchHandler(new Request(`http://x/v1/tools/${program!.id}`, { headers: auth }));
    expect(before.status).toBe(404);

    const approved = await fetchHandler(
      new Request(`http://x/v1/tools/${program!.id}/approve`, { method: "POST", headers: auth, body: "{}" }),
    );
    expect(approved.status).toBe(200);
    expect(store.liveCount()).toBe(1);
    const live = store.tool(program!.id);
    expect(live?.state).toBe("live");
    expect(live?.program.composedOf).toEqual(program!.composedOf);
    expect(live?.program.origin?.mode).toBe("compose");
  });
});
