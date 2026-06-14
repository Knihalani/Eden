"use client";

import { Position, type NodeProps } from "@xyflow/react";
import { Bot } from "lucide-react";

import type { AgentBlockData } from "../../_lib/types";
import { NodeShell } from "../NodeShell";

export function AgentNode({ data, selected }: NodeProps) {
  const d = data as unknown as AgentBlockData;
  return (
    <NodeShell
      kind="agent"
      label="Agent"
      selected={selected}
      icon={<Bot className="w-3.5 h-3.5" />}
      outputs={[{ id: "out:agent", position: Position.Right }]}
    >
      <div className="font-mono text-[11px]">{d.name}</div>
      <div className="text-[10px] text-zinc-500">
        framework: <span className="text-zinc-300">{d.framework}</span>
      </div>
    </NodeShell>
  );
}
