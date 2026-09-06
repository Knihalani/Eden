import { afterAll, describe, expect, test } from "bun:test";
import { compileTraces, intakeBillingHandoffTraces, assertHandoffNotLive } from "@eden/compile";
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

describe("composed handoff approve gate", () => {
  test("POST /v1/tools/:id/approve turns a composed candidate On and never auto-On", async () => {
    const traces = intakeBillingHandoffTraces(3);
    const { programs } = compileTraces(traces);
    const program = programs.find((p) => p.composedOf?.length === 2);
    expect(program).toBeTruthy();
    expect(program!.manifest).toBeNull();
    expect(program!.origin?.mode).toBe("handoff");
    assertHandoffNotLive(program!);

    const store = new Store(":memory:");
    for (const t of traces) store.putTrace(t);
    store.putCandidate({
      id: program!.id,
      sequence: program!.sequence ?? [],
      program,
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
    expect(live?.program.origin?.mode).toBe("handoff");
  });
});
