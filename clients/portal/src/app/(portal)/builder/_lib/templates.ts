/**
 * templates — pre-built starter DAGs the user can one-click
 * into the canvas. Each template returns a fresh
 * ``{ nodes, edges, graphName }`` so the IDs are unique on
 * load and the user can edit without colliding with an
 * existing graph.
 *
 * Templates use the same ``makeBlockNode`` factory the
 * regular addNode path uses, so they round-trip cleanly
 * through the spec translator + tarball builder.
 */

import {
  makeBlockNode,
  type EdenEdge,
  type EdenNode,
} from "./types";
import type { BlockData } from "@/lib/types";

export interface BuilderTemplate {
  id: string;
  name: string;
  description: string;
  /** Iconic emoji used in the menu (lucide icons get tiresome
   *  for "category" badges; an emoji reads faster). */
  emoji: string;
  build: () => { graphName: string; nodes: EdenNode[]; edges: EdenEdge[] };
}

function edge(
  source: EdenNode,
  target: EdenNode,
  sourceHandle: string,
  targetHandle: string,
): EdenEdge {
  return {
    id: `${source.id}->${target.id}::${sourceHandle}->${targetHandle}`,
    source: source.id,
    target: target.id,
    sourceHandle,
    targetHandle,
    data: { kind: "data" },
  };
}

const codingEval: BuilderTemplate = {
  id: "coding-eval",
  name: "Coding Eval",
  emoji: "🧪",
  description:
    "Agent + a shell tool + a coding scenario. Use as a one-click starting point for a single-scenario coding test.",
  build: () => {
    const agent = makeBlockNode("agent", { x: 40, y: 120 });
    const tool = makeBlockNode("tool", { x: 40, y: 280 });
    const scenario = makeBlockNode(
      "scenario",
      { x: 380, y: 120 },
      "scenario_coding",
    );
    const scoring = makeBlockNode("scoring", { x: 380, y: 320 });
    return {
      graphName: "Coding Eval",
      nodes: [agent, tool, scenario, scoring],
      edges: [
        edge(agent, scenario, "out:agent", "in:agent"),
        edge(tool, scenario, "out:tool", "in:tool"),
        edge(scoring, scenario, "out:scoring", "in:scoring"),
      ],
    };
  },
};

const toolUseEval: BuilderTemplate = {
  id: "tool-use-eval",
  name: "Tool-Use Eval",
  emoji: "🔧",
  description:
    "Agent with 2 tools across 2 scenarios. For comparing tool-call success across env variants.",
  build: () => {
    const agent = makeBlockNode("agent", { x: 40, y: 100 });
    const toolA = makeBlockNode("tool", { x: 40, y: 260 });
    const toolB = makeBlockNode("tool", { x: 40, y: 400 });
    const scenarioA = makeBlockNode(
      "scenario",
      { x: 380, y: 100 },
      "scenario_tool_a",
    );
    const scenarioB = makeBlockNode(
      "scenario",
      { x: 380, y: 280 },
      "scenario_tool_b",
    );
    const scoring = makeBlockNode("scoring", { x: 380, y: 480 });
    return {
      graphName: "Tool-Use Eval",
      nodes: [agent, toolA, toolB, scenarioA, scenarioB, scoring],
      edges: [
        edge(agent, scenarioA, "out:agent", "in:agent"),
        edge(agent, scenarioB, "out:agent", "in:agent"),
        edge(toolA, scenarioA, "out:tool", "in:tool"),
        edge(toolB, scenarioB, "out:tool", "in:tool"),
        edge(scoring, scenarioA, "out:scoring", "in:scoring"),
        edge(scoring, scenarioB, "out:scoring", "in:scoring"),
      ],
    };
  },
};

const memoryStress: BuilderTemplate = {
  id: "memory-stress",
  name: "Memory Stress",
  emoji: "🧠",
  description:
    "Agent + long-term memory + 3-episode scenario. Tests whether the agent keeps state across episodes.",
  build: () => {
    const agent = makeBlockNode("agent", { x: 40, y: 100 });
    const memory = makeBlockNode("memory", { x: 40, y: 280 });
    const scenario = makeBlockNode(
      "scenario",
      { x: 380, y: 100 },
      "scenario_memory",
    );
    // Bump maxEpisodes to 3 for the stress test
    scenario.data = {
      ...(scenario.data as Record<string, unknown>),
      maxEpisodes: 3,
    } as unknown as Record<string, unknown> & BlockData;
    return {
      graphName: "Memory Stress",
      nodes: [agent, memory, scenario],
      edges: [
        edge(agent, scenario, "out:agent", "in:agent"),
        edge(memory, scenario, "out:memory", "in:memory"),
      ],
    };
  },
};

const reflexionLoop: BuilderTemplate = {
  id: "reflexion-loop",
  name: "Reflexion Loop",
  emoji: "🔁",
  description:
    "Agent + reflexion loop + a scenario. The agent re-attempts failed steps with the prior context.",
  build: () => {
    const agent = makeBlockNode("agent", { x: 40, y: 100 });
    const loop = makeBlockNode("loop", { x: 40, y: 280 });
    const scenario = makeBlockNode(
      "scenario",
      { x: 380, y: 100 },
      "scenario_reflexion",
    );
    return {
      graphName: "Reflexion Loop",
      nodes: [agent, loop, scenario],
      edges: [
        edge(agent, scenario, "out:agent", "in:agent"),
        edge(loop, scenario, "out:loop", "in:loop"),
      ],
    };
  },
};

const multiSweep: BuilderTemplate = {
  id: "multi-sweep",
  name: "Multi-Scenario Sweep",
  emoji: "🌐",
  description:
    "Agent + 3 scenarios + scoring. Run the same agent across 3 different envs to compare pass rates.",
  build: () => {
    const agent = makeBlockNode("agent", { x: 40, y: 200 });
    const scenarioA = makeBlockNode(
      "scenario",
      { x: 380, y: 60 },
      "scenario_a",
    );
    const scenarioB = makeBlockNode(
      "scenario",
      { x: 380, y: 220 },
      "scenario_b",
    );
    const scenarioC = makeBlockNode(
      "scenario",
      { x: 380, y: 380 },
      "scenario_c",
    );
    const scoring = makeBlockNode("scoring", { x: 720, y: 220 });
    return {
      graphName: "Multi-Scenario Sweep",
      nodes: [agent, scenarioA, scenarioB, scenarioC, scoring],
      edges: [
        edge(agent, scenarioA, "out:agent", "in:agent"),
        edge(agent, scenarioB, "out:agent", "in:agent"),
        edge(agent, scenarioC, "out:agent", "in:agent"),
        edge(scoring, scenarioA, "out:scoring", "in:scoring"),
        edge(scoring, scenarioB, "out:scoring", "in:scoring"),
        edge(scoring, scenarioC, "out:scoring", "in:scoring"),
      ],
    };
  },
};

export const TEMPLATES: readonly BuilderTemplate[] = [
  codingEval,
  toolUseEval,
  memoryStress,
  reflexionLoop,
  multiSweep,
];
