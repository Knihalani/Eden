/**
 * OOM plan 4.5 + 4.6 / W2-12
 *
 * 4.5  wrapLangGraph — emit graph.node_start / graph.node_end events on
 *      invoke (non-streaming) and stream (per-node chunks).
 *
 * 4.6  Doctor sampling nudge (S10) — runDoctor warns when sent > 10k and
 *      samplingProfile === "full".
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDefaultClient, resetDefaultClient } from "../src/client.js";
import { configure } from "../src/trace.js";
import { wrapLangGraph } from "../src/instrumentations/langgraph.js";
import { runDoctor } from "../src/doctor.js";
import type { TelemetryEvent } from "../src/types.js";

// ── test helpers ───────────────────────────────────────────────────────────

/** Capture all events emitted via client.emit() by patching client internals. */
function captureEmit(): { events: TelemetryEvent[]; restore: () => void } {
  const events: TelemetryEvent[] = [];
  const client = getDefaultClient();
  const orig = client.emit.bind(client);
  client.emit = (event: TelemetryEvent) => {
    events.push(event);
    // Don't actually call original — keeps tests hermetic (no HTTP).
  };
  return {
    events,
    restore: () => {
      client.emit = orig;
    },
  };
}

/** Minimal CompiledGraph-shaped mock with invoke + stream. */
function _makeGraph(opts: {
  name?: string;
  invokeReturn?: Record<string, unknown>;
  streamChunks?: Record<string, unknown>[];
}) {
  const name = opts.name ?? "my-graph";
  const invokeReturn = opts.invokeReturn ?? { output: "done", count: 1 };
  const streamChunks = opts.streamChunks ?? [
    { node_a: { messages: ["hi"], step: 1 } },
    { node_b: { result: "ok" } },
  ];

  return {
    name,
    invokeCallCount: 0,
    streamCallCount: 0,

    invoke(input: unknown): Promise<unknown> {
      this.invokeCallCount++;
      return Promise.resolve(invokeReturn);
    },

    async *stream(input: unknown): AsyncGenerator<unknown> {
      this.streamCallCount++;
      for (const chunk of streamChunks) {
        yield chunk;
      }
    },
  };
}

// ── lifecycle ──────────────────────────────────────────────────────────────

beforeEach(() => {
  resetDefaultClient();
  configure({ orgId: "org_test", apiKey: "key_test" });
});

afterEach(async () => {
  await getDefaultClient().dispose();
  resetDefaultClient();
});

// ── wrapLangGraph: invoke ──────────────────────────────────────────────────

describe("wrapLangGraph — invoke", () => {
  it("emits graph.node_start then graph.node_end on successful invoke", async () => {
    const graph = _makeGraph({});
    const { events, restore } = captureEmit();
    try {
      const wrapped = wrapLangGraph(graph);
      const result = await wrapped.invoke({ question: "what?" });

      // Original result is passed through unchanged.
      expect(result).toEqual({ output: "done", count: 1 });
      expect(graph.invokeCallCount).toBe(1);

      const types = events.map((e) => e.eventType);
      expect(types).toContain("graph.node_start");
      expect(types).toContain("graph.node_end");

      const start = events.find((e) => e.eventType === "graph.node_start")!;
      const end = events.find((e) => e.eventType === "graph.node_end")!;

      expect(start.attributes?.["langgraph.framework"]).toBe("langgraph");
      expect(start.attributes?.["langgraph.node"]).toBe("my-graph");
      expect(end.payload?.outcome).toBe("success");
      // End span state_keys must reflect the invoke return value.
      const stateKeys = (end.attributes?.["langgraph.state_keys"] as string[]) ?? [];
      expect(stateKeys.sort()).toEqual(["count", "output"]);
    } finally {
      restore();
    }
  });

  it("emits node_end with outcome=error when invoke throws", async () => {
    const errGraph = {
      name: "bad-graph",
      invoke(_: unknown): Promise<unknown> {
        return Promise.reject(new Error("graph exploded"));
      },
      stream: undefined,
    };

    const { events, restore } = captureEmit();
    try {
      const wrapped = wrapLangGraph(errGraph);
      await expect(wrapped.invoke({})).rejects.toThrow("graph exploded");

      const end = events.find((e) => e.eventType === "graph.node_end");
      expect(end).toBeDefined();
      expect(end?.payload?.outcome).toBe("error");
      expect(String(end?.attributes?.["langgraph.error"])).toContain("graph exploded");
    } finally {
      restore();
    }
  });

  it("returns the same proxy when wrapped twice (no-op re-wrap)", async () => {
    const graph = _makeGraph({});
    const w1 = wrapLangGraph(graph);
    const w2 = wrapLangGraph(w1);
    expect(w2).toBe(w1);
  });

  it("carries a non-empty traceId on every emitted event", async () => {
    const graph = _makeGraph({});
    const { events, restore } = captureEmit();
    try {
      const wrapped = wrapLangGraph(graph);
      await wrapped.invoke({});
      for (const ev of events) {
        expect(ev.traceId).toBeTruthy();
      }
    } finally {
      restore();
    }
  });
});

// ── wrapLangGraph: stream ──────────────────────────────────────────────────

describe("wrapLangGraph — stream", () => {
  it("emits node_start + node_end for each node in each chunk", async () => {
    const graph = _makeGraph({});
    const { events, restore } = captureEmit();
    try {
      const wrapped = wrapLangGraph(graph);
      const chunks: unknown[] = [];
      for await (const chunk of wrapped.stream({ input: "test" })) {
        chunks.push(chunk);
      }

      expect(graph.streamCallCount).toBe(1);
      // Chunks must pass through unchanged.
      expect(chunks).toEqual([
        { node_a: { messages: ["hi"], step: 1 } },
        { node_b: { result: "ok" } },
      ]);

      const nodeNames = new Set(
        events.map((e) => e.attributes?.["langgraph.node"] as string),
      );
      expect(nodeNames.has("node_a")).toBe(true);
      expect(nodeNames.has("node_b")).toBe(true);

      // Both nodes must have exactly one start and one end.
      for (const node of ["node_a", "node_b"]) {
        const starts = events.filter(
          (e) => e.eventType === "graph.node_start" && e.attributes?.["langgraph.node"] === node,
        );
        const ends = events.filter(
          (e) => e.eventType === "graph.node_end" && e.attributes?.["langgraph.node"] === node,
        );
        expect(starts.length).toBe(1);
        expect(ends.length).toBe(1);
      }
    } finally {
      restore();
    }
  });

  it("records state_keys from the per-node state object", async () => {
    const graph = _makeGraph({
      streamChunks: [{ my_node: { alpha: 1, beta: 2, gamma: 3 } }],
    });
    const { events, restore } = captureEmit();
    try {
      const wrapped = wrapLangGraph(graph);
      for await (const _ of wrapped.stream({})) { /* drain */ }

      const end = events.find(
        (e) => e.eventType === "graph.node_end" && e.attributes?.["langgraph.node"] === "my_node",
      );
      expect(end).toBeDefined();
      const keys = ((end?.attributes?.["langgraph.state_keys"] as string[]) ?? []).sort();
      expect(keys).toEqual(["alpha", "beta", "gamma"]);
    } finally {
      restore();
    }
  });
});

// ── wrapLangGraph: detectInstalledFrameworks includes langgraph ─────────────

describe("detectInstalledFrameworks includes langgraph key", () => {
  it("returns langgraph as a boolean", () => {
    const { detectInstalledFrameworks } = require("../src/detect-installed.js");
    const result = detectInstalledFrameworks();
    expect(typeof result.langgraph).toBe("boolean");
  });
});

// ── Doctor sampling nudge (S10) ─────────────────────────────────────────────

describe("runDoctor — sampling nudge (S10)", () => {
  it("sampling_nudge check is present in the report", async () => {
    const report = await runDoctor({ emitTestEvent: false });
    const nudge = report.checks.find((c) => c.name === "samplingNudge");
    expect(nudge).toBeDefined();
  });

  it("samplingNudge is ok when sent is 0 (below threshold)", async () => {
    // Default client has sent=0.
    const report = await runDoctor({ emitTestEvent: false });
    const nudge = report.checks.find((c) => c.name === "samplingNudge")!;
    expect(nudge.ok).toBe(true);
  });

  it("samplingNudge warns when sent > 10k and profile is full", async () => {
    const client = getDefaultClient();
    // Monkey-patch: override `sent` to simulate 20k delivered events.
    const origDescriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(client),
      "sent",
    );
    Object.defineProperty(client, "sent", {
      get: () => 20_000,
      configurable: true,
    });

    try {
      const report = await runDoctor({ emitTestEvent: false });
      const nudge = report.checks.find((c) => c.name === "samplingNudge")!;
      expect(nudge.ok).toBe(false);
      expect(nudge.message.toLowerCase()).toContain("balanced");
      expect(nudge.detail?.sentTotal).toBe(20_000);
      expect(nudge.detail?.samplingProfile).toBe("full");
    } finally {
      if (origDescriptor) {
        Object.defineProperty(client, "sent", origDescriptor);
      } else {
        // @ts-expect-error — reverting the override
        delete client.sent;
      }
    }
  });

  it("samplingNudge is ok when sent > 10k but profile is balanced", async () => {
    // Recreate client with balanced profile.
    resetDefaultClient();
    // EdenClient accepts samplingProfile in the constructor opts.
    const { EdenSDK } = await import("../src/client.js");
    const balancedClient = new EdenSDK({
      orgId: "org_test",
      apiKey: "key_test",
      samplingProfile: "balanced",
    });
    // Override sent on the new client.
    Object.defineProperty(balancedClient, "sent", {
      get: () => 20_000,
      configurable: true,
    });
    const { setDefaultClient } = await import("../src/client.js");
    setDefaultClient(balancedClient);

    try {
      const report = await runDoctor({ emitTestEvent: false });
      const nudge = report.checks.find((c) => c.name === "samplingNudge")!;
      expect(nudge.ok).toBe(true);
      expect(nudge.detail?.samplingProfile).toBe("balanced");
    } finally {
      await balancedClient.dispose();
      resetDefaultClient();
      configure({ orgId: "org_test", apiKey: "key_test" });
    }
  });
});
