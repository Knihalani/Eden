"use client";

import { Position, type NodeProps } from "@xyflow/react";
import { FlaskConical } from "lucide-react";

import type { ScenarioBlockData } from "../../_lib/types";
import { NodeShell } from "../NodeShell";

export function ScenarioNode({ data, selected }: NodeProps) {
  const d = data as unknown as ScenarioBlockData;
  return (
    <NodeShell
      kind="scenario"
      label="Scenario"
      selected={selected}
      icon={<FlaskConical className="w-3.5 h-3.5" />}
      inputs={[
        { id: "in:agent", position: Position.Left },
        { id: "in:tool", position: Position.Left },
        { id: "in:scoring", position: Position.Left },
        { id: "in:memory", position: Position.Left },
        { id: "in:loop", position: Position.Left },
      ]}
      outputs={[{ id: "out:scenario", position: Position.Right }]}
    >
      <div className="font-mono text-[11px]">{d.id}</div>
      <div className="text-[10px] text-[var(--text-muted)]">
        {d.envClassName} · {d.maxEpisodes} ep
      </div>
    </NodeShell>
  );
}
