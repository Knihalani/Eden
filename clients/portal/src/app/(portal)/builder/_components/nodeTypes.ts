/**
 * Registry of custom node components for the React Flow canvas.
 * The map is keyed by the ``type`` field on each EdenNode (which
 * matches the BlockData kind). The Canvas component imports
 * this map and passes it to <ReactFlow nodeTypes={...} />.
 */

import type { NodeTypes } from "@xyflow/react";

import { AgentNode } from "./nodes/AgentNode";
import { LoopNode } from "./nodes/LoopNode";
import { MemoryNode } from "./nodes/MemoryNode";
import { ScenarioNode } from "./nodes/ScenarioNode";
import { ScoringNode } from "./nodes/ScoringNode";
import { SeedNode } from "./nodes/SeedNode";
import { ToolNode } from "./nodes/ToolNode";

export const nodeTypes: NodeTypes = {
  agent: AgentNode as unknown as NodeTypes[string],
  tool: ToolNode as unknown as NodeTypes[string],
  scenario: ScenarioNode as unknown as NodeTypes[string],
  scoring: ScoringNode as unknown as NodeTypes[string],
  memory: MemoryNode as unknown as NodeTypes[string],
  loop: LoopNode as unknown as NodeTypes[string],
  seed: SeedNode as unknown as NodeTypes[string],
};
