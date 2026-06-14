"use client";

import { Position, type NodeProps } from "@xyflow/react";
import { Repeat } from "lucide-react";

import type { LoopBlockData } from "../../_lib/types";
import { NodeShell } from "../NodeShell";

export function LoopNode({ data, selected }: NodeProps) {
  const d = data as unknown as LoopBlockData;
  return (
    <NodeShell
      kind="loop"
      label="Loop"
      selected={selected}
      icon={<Repeat className="w-3.5 h-3.5" />}
      outputs={[{ id: "out:loop", position: Position.Right }]}
    >
      <div className="text-[11px]">{d.loopType}</div>
      <div className="text-[10px] text-zinc-500">
        max: <span className="text-zinc-300">{d.maxIterations}</span>
      </div>
    </NodeShell>
  );
}
