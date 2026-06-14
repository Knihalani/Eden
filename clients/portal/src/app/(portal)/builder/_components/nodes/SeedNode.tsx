"use client";

import { type NodeProps } from "@xyflow/react";
import { Dice5 } from "lucide-react";

import type { SeedBlockData } from "../../_lib/types";
import { NodeShell } from "../NodeShell";

export function SeedNode({ data, selected }: NodeProps) {
  const d = data as unknown as SeedBlockData;
  return (
    <NodeShell
      kind="seed"
      label="Seed"
      selected={selected}
      icon={<Dice5 className="w-3.5 h-3.5" />}
    >
      <div className="font-mono text-[11px]">seed = {d.value}</div>
      <div className="text-[10px] text-[var(--text-muted)]">determinism on</div>
    </NodeShell>
  );
}
