"use client";

import { Position, type NodeProps } from "@xyflow/react";
import { Wrench } from "lucide-react";

import type { ToolBlockData } from "../../_lib/types";
import { NodeShell } from "../NodeShell";

export function ToolNode({ data, selected }: NodeProps) {
  const d = data as unknown as ToolBlockData;
  const configCount = Object.keys(d.config || {}).length;
  return (
    <NodeShell
      kind="tool"
      label="Tool"
      selected={selected}
      icon={<Wrench className="w-3.5 h-3.5" />}
      outputs={[{ id: "out:tool", position: Position.Right }]}
    >
      <div className="font-mono text-[11px]">{d.name}</div>
      <div className="text-[10px] text-[var(--text-muted)]">
        {d.toolKind}
        {configCount > 0 ? ` · ${configCount} cfg` : ""}
      </div>
    </NodeShell>
  );
}
