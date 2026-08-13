// @vitest-environment jsdom
/**
 * W4-5 — AgentsPanel: renders agent nodes + handoff edges for multi-agent
 * traces; returns nothing for single-agent traces.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TraceFixture } from "@/lab/fixtures/traces";

// agentById drives the label; return null so the raw agent ID is used.
vi.mock("@/lab/fixtures/agents", () => ({
  agentById: () => null,
}));

// agentLaneColor drives the node fill; deterministic stub is fine.
vi.mock("@/lib/observability/build-transcript-rows", () => ({
  agentLaneColor: (id: string) =>
    id === "orchestrator" ? "var(--chart-pie-1)" : "var(--chart-pie-2)",
}));

// Dynamic import requires stable module resolution in vitest.
import { AgentsPanel, buildAgentGraph } from "./traces-detail-panels";

// ── Fixtures ────────────────────────────────────────────────────────────────

const singleAgentTrace: TraceFixture = {
  id: "trace-single",
  agentId: "agent-solo",
  name: "Solo run",
  status: "ok",
  startedAt: "2026-08-12T10:00:00Z",
  durationMs: 1000,
  tokens: 100,
  costUsd: 0.01,
  severity: "none",
  signals: { title: "", body: "" },
  steps: [
    {
      id: "s1",
      kind: "llm",
      title: "Generate",
      durationMs: 800,
      agentId: "agent-solo",
    },
  ],
};

const multiAgentTrace: TraceFixture = {
  id: "trace-multi",
  agentId: "orchestrator",
  participants: ["orchestrator", "worker-a", "worker-b"],
  name: "Multi-agent run",
  status: "ok",
  startedAt: "2026-08-12T10:00:00Z",
  durationMs: 5000,
  tokens: 1000,
  costUsd: 0.1,
  severity: "none",
  signals: { title: "", body: "" },
  steps: [
    {
      id: "s1",
      kind: "agent",
      title: "Orchestrator boot",
      durationMs: 100,
      agentId: "orchestrator",
    },
    {
      id: "handoff-1",
      kind: "handoff",
      title: "orchestrator → worker-a",
      durationMs: 10,
      agentId: "orchestrator",
      attributes: {
        "a2a.parent_agent_id": "orchestrator",
        "a2a.child_agent_id": "worker-a",
        "a2a.invocation_type": "a2a.send_message",
      },
    },
    {
      id: "s2",
      kind: "tool",
      title: "worker-a task",
      durationMs: 2000,
      agentId: "worker-a",
    },
    {
      id: "handoff-2",
      kind: "handoff",
      title: "orchestrator → worker-b",
      durationMs: 10,
      agentId: "orchestrator",
      attributes: {
        "a2a.parent_agent_id": "orchestrator",
        "a2a.child_agent_id": "worker-b",
        "a2a.invocation_type": "a2a.send_message",
      },
    },
    {
      id: "s3",
      kind: "tool",
      title: "worker-b task",
      durationMs: 1500,
      agentId: "worker-b",
    },
  ],
};

// ── buildAgentGraph unit tests ───────────────────────────────────────────────

describe("buildAgentGraph", () => {
  it("returns null for a single-agent trace", () => {
    expect(buildAgentGraph(singleAgentTrace)).toBeNull();
  });

  it("returns 3 nodes for a 3-agent trace", () => {
    const graph = buildAgentGraph(multiAgentTrace);
    expect(graph).not.toBeNull();
    expect(graph!.nodes).toHaveLength(3);
    const ids = graph!.nodes.map((n) => n.id);
    expect(ids).toContain("orchestrator");
    expect(ids).toContain("worker-a");
    expect(ids).toContain("worker-b");
  });

  it("returns 2 edges for 2 distinct handoff pairs", () => {
    const graph = buildAgentGraph(multiAgentTrace);
    expect(graph!.edges).toHaveLength(2);
    const pairs = graph!.edges.map((e) => `${e.from}→${e.to}`);
    expect(pairs).toContain("orchestrator→worker-a");
    expect(pairs).toContain("orchestrator→worker-b");
  });

  it("orchestrator lands in column 0 (root)", () => {
    const graph = buildAgentGraph(multiAgentTrace);
    const orch = graph!.nodes.find((n) => n.id === "orchestrator");
    expect(orch?.col).toBe(0);
  });

  it("workers land in column 1 (children)", () => {
    const graph = buildAgentGraph(multiAgentTrace);
    const wa = graph!.nodes.find((n) => n.id === "worker-a");
    const wb = graph!.nodes.find((n) => n.id === "worker-b");
    expect(wa?.col).toBe(1);
    expect(wb?.col).toBe(1);
  });

  it("accumulates repeated handoffs onto the same edge count", () => {
    const trace: TraceFixture = {
      ...multiAgentTrace,
      steps: [
        ...multiAgentTrace.steps,
        {
          id: "handoff-3",
          kind: "handoff",
          title: "orchestrator → worker-a again",
          durationMs: 5,
          agentId: "orchestrator",
          attributes: {
            "a2a.parent_agent_id": "orchestrator",
            "a2a.child_agent_id": "worker-a",
            "a2a.invocation_type": "a2a.send_message",
          },
        },
      ],
    };
    const graph = buildAgentGraph(trace);
    const e = graph!.edges.find(
      (x) => x.from === "orchestrator" && x.to === "worker-a",
    );
    expect(e?.count).toBe(2);
  });
});

// ── AgentsPanel render tests ─────────────────────────────────────────────────

describe("AgentsPanel", () => {
  it("renders nothing for a single-agent trace", () => {
    const { container } = render(<AgentsPanel trace={singleAgentTrace} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders an SVG for a multi-agent trace", () => {
    render(<AgentsPanel trace={multiAgentTrace} />);
    expect(document.querySelector("svg")).toBeTruthy();
  });

  it("renders a node for each agent", () => {
    render(<AgentsPanel trace={multiAgentTrace} />);
    const nodes = document.querySelectorAll("[data-testid='agent-node']");
    expect(nodes.length).toBe(3);
  });

  it("renders an edge for each handoff pair", () => {
    render(<AgentsPanel trace={multiAgentTrace} />);
    const edges = document.querySelectorAll("[data-testid='agent-edge']");
    expect(edges.length).toBe(2);
  });

  it("labels each agent node with the agent id (fallback when agentById returns null)", () => {
    render(<AgentsPanel trace={multiAgentTrace} />);
    // Label text uses node.label = agentById(id)?.name ?? id
    // Since we mock agentById to return null, the raw id is used.
    expect(
      screen.getByTestId("agent-node-label-orchestrator"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-node-label-worker-a"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-node-label-worker-b"),
    ).toBeInTheDocument();
  });
});
