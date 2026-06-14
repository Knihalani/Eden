"use client";

import { Position, type NodeProps } from "@xyflow/react";
import { Gauge } from "lucide-react";

import type { ScoringBlockData } from "../../_lib/types";
import { NodeShell } from "../NodeShell";

export function ScoringNode({ data, selected }: NodeProps) {
  const d = data as unknown as ScoringBlockData;
  return (
    <NodeShell
      kind="scoring"
      label="Scoring"
      selected={selected}
      icon={<Gauge className="w-3.5 h-3.5" />}
      outputs={[{ id: "out:scoring", position: Position.Right }]}
    >
      <div className="text-[11px]">
        {d.criteria.length} criterion
        {d.criteria.length === 1 ? "" : "s"}
      </div>
      <div className="text-[10px] text-[var(--text-muted)] truncate">
        {d.criteria
          .slice(0, 2)
          .map((c) => c.name)
          .join(", ")}
        {d.criteria.length > 2 ? "…" : ""}
      </div>
    </NodeShell>
  );
}
