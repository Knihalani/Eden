"use client";

import { Position, type NodeProps } from "@xyflow/react";
import { Brain } from "lucide-react";

import type { MemoryBlockData } from "../../_lib/types";
import { NodeShell } from "../NodeShell";

export function MemoryNode({ data, selected }: NodeProps) {
  const d = data as unknown as MemoryBlockData;
  return (
    <NodeShell
      kind="memory"
      label="Memory"
      selected={selected}
      icon={<Brain className="w-3.5 h-3.5" />}
      outputs={[{ id: "out:memory", position: Position.Right }]}
    >
      <div className="text-[11px]">{d.memoryType}</div>
      <div className="text-[10px] text-[var(--text-muted)]">
        capacity: <span className="text-[var(--text-muted)]">{d.capacity}</span>
      </div>
    </NodeShell>
  );
}
