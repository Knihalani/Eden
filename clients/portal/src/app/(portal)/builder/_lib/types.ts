/**
 * Builder-local types. Re-exports the data shapes from
 * ``@/lib/types.ts`` and wraps them in React Flow's Node/Edge
 * generics so the rest of the builder can write ``EdenNode`` /
 * ``EdenEdge`` and stay in touch with React Flow's selector API.
 */

import type { Edge, Node } from "@xyflow/react";
import type {
  AgentBlockData,
  BlockData,
  EdenEdgeData,
  LoopBlockData,
  MemoryBlockData,
  ScenarioBlockData,
  ScoringBlockData,
  SeedBlockData,
  ToolBlockData,
} from "@/lib/types";

export type {
  AgentBlockData,
  BlockData,
  BlockKind,
  CriterionData,
  EdenEdgeData,
  HandleId,
  LoopBlockData,
  MemoryBlockData,
  SavedGraph,
  SavedGraphMeta,
  ScenarioBlockData,
  ScoringBlockData,
  SeedBlockData,
  SpecBundle,
  SpecValidationError,
  ToolBlockData,
} from "@/lib/types";

// React Flow v12 constrains ``Node<T>`` and ``Edge<T>`` to ``T
// extends Record<string, unknown>``. Our BlockData is a
// discriminated union without an index signature (by design —
// the kinds carry type info). We work around the constraint
// by widening EdenNode/EdenEdge to the unparameterised Node /
// Edge and casting at the boundary; the block data shape is
// still enforced by the typed constructors in this file and
// by the per-kind form components.
export type EdenNode = Node & { data: BlockData };
export type EdenEdge = Edge & { data?: EdenEdgeData };

/** Friendly default seed value. */
export const DEFAULT_SEED = 42;

/** Defensive upper bound for the seed (matches Python's int range we accept). */
export const MAX_SEED = 2_147_483_647;

/** A node that is freshly dropped onto the canvas (default values). */
export function makeBlockNode(
  kind: BlockData["kind"],
  position: { x: number; y: number },
  id?: string,
): EdenNode {
  const newId = id ?? `${kind}_${Math.random().toString(36).slice(2, 9)}`;
  switch (kind) {
    case "agent":
      return {
        id: newId,
        type: "agent",
        position,
        data: {
          kind: "agent",
          label: "Agent",
          name: "agent",
          framework: "langchain",
        } satisfies AgentBlockData,
      };
    case "tool":
      return {
        id: newId,
        type: "tool",
        position,
        data: {
          kind: "tool",
          label: "Tool",
          name: `tool_${Math.random().toString(36).slice(2, 5)}`,
          toolKind: "shell",
          config: {},
        } satisfies ToolBlockData,
      };
    case "scenario":
      return {
        id: newId,
        type: "scenario",
        position,
        data: {
          kind: "scenario",
          label: "Scenario",
          id: `scenario_${Math.random().toString(36).slice(2, 6)}`,
          envClassName: "SimEnv",
          maxEpisodes: 5,
          description: "",
        } satisfies ScenarioBlockData,
      };
    case "scoring":
      return {
        id: newId,
        type: "scoring",
        position,
        data: {
          kind: "scoring",
          label: "Scoring",
          criteria: [
            { name: "quality", kind: "quality", weight: 1.0 },
          ],
        } satisfies ScoringBlockData,
      };
    case "memory":
      return {
        id: newId,
        type: "memory",
        position,
        data: {
          kind: "memory",
          label: "Memory",
          memoryType: "short-term",
          capacity: 10,
        } satisfies MemoryBlockData,
      };
    case "loop":
      return {
        id: newId,
        type: "loop",
        position,
        data: {
          kind: "loop",
          label: "Loop",
          loopType: "retry",
          maxIterations: 3,
        } satisfies LoopBlockData,
      };
    case "seed":
      return {
        id: newId,
        type: "seed",
        position,
        data: {
          kind: "seed",
          label: "Seed",
          value: DEFAULT_SEED,
        } satisfies SeedBlockData,
      };
  }
}
