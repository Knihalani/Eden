/**
 * validHandles — central allow-list for which source/target
 * handle pairs may be connected on the builder canvas.
 *
 * The blocks expose these handles:
 *   - Agent    : out:agent
 *   - Tool     : out:tool
 *   - Scenario : in:agent, in:tool, in:scoring, in:memory, in:loop, out:scenario
 *   - Scoring  : out:scoring
 *   - Memory   : out:memory
 *   - Loop     : out:loop
 *   - Seed     : (no handles)
 *
 * The valid pairs are derived from the data flow:
 *   any output → matching scenario input
 *   scenario → scenario (out:scenario) is reserved for future
 *     composition and is not yet wired.
 *
 * Used by:
 *   - Canvas.tsx (React Flow's ``isValidConnection`` prop) so
 *     the drag-and-drop visual shows red on invalid targets.
 *   - useBuilderState.onConnect as a hard backstop (rejects
 *     anything that slips past, e.g. programmatic).
 */

import type { EdenNode } from "./types";

export type SourceHandle =
  | "out:agent"
  | "out:tool"
  | "out:scenario"
  | "out:scoring"
  | "out:memory"
  | "out:loop";

export type TargetHandle =
  | "in:agent"
  | "in:tool"
  | "in:scoring"
  | "in:memory"
  | "in:loop";

const VALID_PAIRS: ReadonlyArray<readonly [SourceHandle, TargetHandle]> = [
  ["out:agent", "in:agent"],
  ["out:tool", "in:tool"],
  ["out:scoring", "in:scoring"],
  ["out:memory", "in:memory"],
  ["out:loop", "in:loop"],
];

export function isValidHandlePair(
  source: SourceHandle | null,
  target: TargetHandle | null,
): boolean {
  if (!source || !target) return false;
  return VALID_PAIRS.some(([s, t]) => s === source && t === target);
}

/**
 * React Flow's ``isValidConnection`` callback. Returns true iff
 * the source + sourceHandle and target + targetHandle are a
 * valid pair. The ``nodes`` array is used to look up the block
 * kind (so we can, in the future, also enforce kind-level
 * constraints).
 */
export function makeIsValidConnection(
  nodes: EdenNode[],
): (params: {
  source: string | null;
  target: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}) => boolean {
  return ({ source, target, sourceHandle, targetHandle }) => {
    if (!source || !target) return false;
    if (source === target) return false; // self-loops are never allowed
    const srcNode = nodes.find((n) => n.id === source);
    const tgtNode = nodes.find((n) => n.id === target);
    if (!srcNode || !tgtNode) return false;
    return isValidHandlePair(
      (sourceHandle ?? null) as SourceHandle | null,
      (targetHandle ?? null) as TargetHandle | null,
    );
  };
}

/** Human-readable reason for a rejected connection (used in toasts). */
export function rejectionReason(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
): string {
  if (!sourceHandle) return "Source handle missing.";
  if (!targetHandle) return "Target handle missing.";
  if (sourceHandle === targetHandle.replace("in:", "out:")) {
    return `${sourceHandle} is an output handle; connect it to a Scenario's input.`;
  }
  return `${sourceHandle} cannot connect to ${targetHandle}.`;
}
