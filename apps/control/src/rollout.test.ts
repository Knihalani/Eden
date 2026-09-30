import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withVersion, type StretchProgram } from "@eden/ir";
import { createHandler } from "./server";
import { useTempEdenHome } from "./test-home";
import { Store } from "./store";

const FILE_HOME = useTempEdenHome();
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

const program = (over: Partial<StretchProgram> = {}): StretchProgram =>
  withVersion({
    id: "t",
    name: "t",
    description: "t",
    inputSchema: { type: "object" },
    steps: [{ id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } }],
    returns: { kind: "from", step: "a", path: "" },
    contract: {
      witnesses: 3,
      minLlmReduction: 5,
      allowExact: false,
      envelope: { inputs: { id: ["T-1", "T-2"] } },
    },
    manifest: null,
    ...over,
  });

function handler() {
  const store = new Store(":memory:");
  return { store, fetchHandler: createHandler({ store, token: "eden_dev" }) };
}

const auth = { authorization: "Bearer eden_dev", "content-type": "application/json" };

function putPass(store: Store, p: StretchProgram, id = p.id): void {
  store.putCandidate({
    id,
    sequence: p.sequence ?? [],
    program: p,
    refusal: null,
    verdict: "PASS",
    manifest: passManifest,
    created_at: Date.now(),
  });
}

describe("graduated rollout", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    process.env.EDEN_HOME = FILE_HOME;
  });

  test("Approve ships canary unless body.rollout is live", async () => {
    const { store, fetchHandler } = handler();
    const p = program({ id: "a1", name: "a1" });
    putPass(store, p);
    const canary = await fetchHandler(new Request("http://x/v1/tools/a1/approve", { method: "POST", headers: auth, body: "{}" }));
    expect(canary.status).toBe(200);
    expect(store.tool("a1")?.rollout).toBe("canary");

    const liveP = program({ id: "a2", name: "a2" });
    putPass(store, liveP);
    const live = await fetchHandler(
      new Request("http://x/v1/tools/a2/approve", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ rollout: "live" }),
      }),
    );
    expect(live.status).toBe(200);
    expect(store.tool("a2")?.rollout).toBe("live");
  });

  test("POST promote sets live; missing tool is 404; pause/resume keep canary", async () => {
    const { store, fetchHandler } = handler();
    const p = program({ id: "p1", name: "p1" });
    putPass(store, p);
    await fetchHandler(new Request("http://x/v1/tools/p1/approve", { method: "POST", headers: auth, body: "{}" }));
    expect(store.tool("p1")?.rollout).toBe("canary");

    const miss = await fetchHandler(new Request("http://x/v1/tools/nope/promote", { method: "POST", headers: auth, body: "{}" }));
    expect(miss.status).toBe(404);

    const promoted = await fetchHandler(new Request("http://x/v1/tools/p1/promote", { method: "POST", headers: auth, body: "{}" }));
    expect(promoted.status).toBe(200);
    expect(((await promoted.json()) as { rollout: string }).rollout).toBe("live");
    expect(store.tool("p1")?.rollout).toBe("live");

    const paused = await fetchHandler(new Request("http://x/v1/tools/p1/pause", { method: "POST", headers: auth, body: "{}" }));
    expect(paused.status).toBe(200);
    expect(store.tool("p1")?.state).toBe("paused");
    expect(store.tool("p1")?.rollout).toBe("live");
    const resumed = await fetchHandler(new Request("http://x/v1/tools/p1/resume", { method: "POST", headers: auth, body: "{}" }));
    expect(resumed.status).toBe(200);
    expect(store.tool("p1")?.state).toBe("live");
    expect(store.tool("p1")?.rollout).toBe("live");
  });

  test("dropValues tightens the envelope; emptying or inventing 409s and ships nothing", async () => {
    const { store, fetchHandler } = handler();
    const p = program({ id: "drop", name: "drop" });
    putPass(store, p);
    const emptied = await fetchHandler(
      new Request("http://x/v1/tools/drop/approve", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          dropValues: [
            { path: "id", value: "T-1" },
            { path: "id", value: "T-2" },
          ],
        }),
      }),
    );
    expect(emptied.status).toBe(409);
    expect(store.tool("drop")).toBeUndefined();

    const invented = await fetchHandler(
      new Request("http://x/v1/tools/drop/approve", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ dropValues: [{ path: "id", value: "T-9" }] }),
      }),
    );
    expect(invented.status).toBe(409);
    expect(store.tool("drop")).toBeUndefined();

    const ok = await fetchHandler(
      new Request("http://x/v1/tools/drop/approve", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ dropValues: [{ path: "id", value: "T-2" }] }),
      }),
    );
    expect(ok.status).toBe(200);
    expect(store.tool("drop")?.program.contract.envelope?.inputs.id).toEqual(["T-1"]);
    expect(store.tool("drop")?.rollout).toBe("canary");
  });

  test("pinIslands pins every island on Approve — not a silent swap", async () => {
    const { store, fetchHandler } = handler();
    const p = program({
      id: "isle",
      name: "isle",
      steps: [
        { id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } },
        { id: "think", kind: "island", input: { kind: "input", path: "q" }, system: "s", outputSchema: {} },
      ],
    });
    putPass(store, p);
    const skipped = await fetchHandler(new Request("http://x/v1/tools/isle/approve", { method: "POST", headers: auth, body: "{}" }));
    expect(skipped.status).toBe(200);
    const unpinned = store.tool("isle")!.program.steps.find((s) => s.id === "think");
    expect(unpinned?.kind === "island" && unpinned.pinned).toBeFalsy();
    store.deleteCandidate("isle");

    const p2 = program({
      id: "isle2",
      name: "isle2",
      steps: [
        { id: "a", kind: "tool", tool: "x", args: { id: { kind: "input", path: "id" } } },
        { id: "think", kind: "island", input: { kind: "input", path: "q" }, system: "s", outputSchema: {} },
      ],
    });
    putPass(store, p2, "isle2");
    const pinned = await fetchHandler(
      new Request("http://x/v1/tools/isle2/approve", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ pinIslands: true }),
      }),
    );
    expect(pinned.status).toBe(200);
    const step = store.tool("isle2")!.program.steps.find((s) => s.id === "think");
    expect(step?.kind === "island" && step.pinned === true).toBe(true);
  });

  test("syncLiveTools writes rollout; fail-rate auto-pause still pauses a canary tool", async () => {
    home = mkdtempSync(join(tmpdir(), "eden-rollout-"));
    process.env.EDEN_HOME = home;
    const { store, fetchHandler } = handler();
    const p = program({ id: "sync", name: "sync" });
    putPass(store, p);
    await fetchHandler(new Request("http://x/v1/tools/sync/approve", { method: "POST", headers: auth, body: "{}" }));
    const written = JSON.parse(readFileSync(join(home, "live-tools.json"), "utf8")) as Array<{ id: string; rollout?: string }>;
    expect(written.find((t) => t.id === "sync")?.rollout).toBe("canary");

    for (let i = 0; i < 4; i++) {
      store.putReceipt({ tool_id: "sync", version: store.tool("sync")!.version, ms: 10, llm_calls: 0, cents: 0, ok: 0 });
    }
    expect(store.tool("sync")?.state).toBe("paused");
    expect(store.tool("sync")?.rollout).toBe("canary");
  });
});
