// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SavedGraph } from "@/lib/types";

import {
  clearAll,
  deleteSaved,
  flushGraph,
  listRecent,
  listSaved,
  loadGraph,
  loadSavedByName,
  lookupAgentId,
  persistGraph,
  pushRecent,
  rememberAgentId,
  saveGraphDebounced,
  writeGraph,
} from "../storage";

const SAMPLE: SavedGraph = {
  graphName: "Sample",
  nodes: [
    {
      id: "agent_1",
      type: "agent",
      position: { x: 0, y: 0 },
      data: { kind: "agent", label: "Agent", name: "agent", framework: "langchain" },
    },
  ],
  edges: [],
  updatedAt: 1_700_000_000_000,
};

beforeEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadGraph / writeGraph", () => {
  it("returns null when no active graph", () => {
    expect(loadGraph()).toBeNull();
  });

  it("round-trips a saved graph", () => {
    writeGraph(SAMPLE);
    const loaded = loadGraph();
    expect(loaded).toEqual(SAMPLE);
  });

  it("returns null for corrupt JSON", () => {
    window.localStorage.setItem("eden.builder.graph", "not json");
    expect(loadGraph()).toBeNull();
  });
});

describe("saveGraphDebounced", () => {
  it("coalesces rapid writes into one", () => {
    vi.useFakeTimers();
    saveGraphDebounced({ ...SAMPLE, graphName: "A" });
    saveGraphDebounced({ ...SAMPLE, graphName: "B" });
    saveGraphDebounced({ ...SAMPLE, graphName: "C" });
    // Nothing yet
    expect(loadGraph()).toBeNull();
    vi.advanceTimersByTime(500);
    // Only the last one
    expect(loadGraph()?.graphName).toBe("C");
  });

  it("flushGraph writes immediately", () => {
    saveGraphDebounced(SAMPLE);
    flushGraph();
    expect(loadGraph()).toEqual(SAMPLE);
  });
});

describe("persistGraph / listSaved / listRecent", () => {
  it("persists a graph and lists it", () => {
    persistGraph(SAMPLE);
    const list = listSaved();
    expect(list).toHaveLength(1);
    expect(list[0]?.graphName).toBe("Sample");
  });

  it("caps the saved map at 5 (LRU by updatedAt)", () => {
    for (let i = 0; i < 7; i++) {
      persistGraph({
        ...SAMPLE,
        graphName: `g${i}`,
        updatedAt: 1_700_000_000_000 + i,
      });
    }
    const list = listSaved();
    expect(list).toHaveLength(5);
    // Newest 5 names: g2..g6
    expect(list.map((g) => g.graphName).sort()).toEqual(
      ["g2", "g3", "g4", "g5", "g6"],
    );
  });

  it("pushes a recent meta entry to the top", () => {
    persistGraph(SAMPLE);
    const r = listRecent();
    expect(r).toHaveLength(1);
    expect(r[0]?.graphName).toBe("Sample");
    expect(r[0]?.summary.agents).toBe(1);
  });

  it("deduplicates recent entries by name (LRU move-to-front)", () => {
    persistGraph({ ...SAMPLE, graphName: "A", updatedAt: 1 });
    persistGraph({ ...SAMPLE, graphName: "B", updatedAt: 2 });
    pushRecent({
      graphName: "A",
      updatedAt: 3,
      summary: { agents: 0, tools: 0, scenarios: 0 },
    });
    const r = listRecent();
    expect(r.map((x) => x.graphName)).toEqual(["A", "B"]);
  });
});

describe("deleteSaved / loadSavedByName", () => {
  it("removes a saved graph and its recent entry", () => {
    persistGraph(SAMPLE);
    deleteSaved("Sample");
    expect(loadSavedByName("Sample")).toBeNull();
    expect(listRecent()).toHaveLength(0);
  });
});

describe("clearAll", () => {
  it("wipes active, saved, recent, and agentId keys", () => {
    persistGraph(SAMPLE);
    rememberAgentId("Sample", "agent-123");
    clearAll();
    expect(loadGraph()).toBeNull();
    expect(listSaved()).toHaveLength(0);
    expect(listRecent()).toHaveLength(0);
    expect(lookupAgentId("Sample")).toBeNull();
  });
});

describe("agentId cache", () => {
  it("round-trips an agentId for a graph name", () => {
    rememberAgentId("My Graph", "agent_xyz");
    expect(lookupAgentId("My Graph")).toBe("agent_xyz");
  });
});
