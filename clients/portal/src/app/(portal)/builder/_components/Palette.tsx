/**
 * Palette — the left-rail block picker. Each card is both
 * ``draggable`` (for drag-to-canvas) and click-to-add (for
 * accessibility — keyboard / no-mouse flows). The block kind
 * is encoded in the ``dataTransfer`` payload under
 * ``application/eden-block``; the Canvas component reads this
 * in its ``onDrop`` handler.
 */

"use client";

import {
  Bot,
  Brain,
  Dice5,
  FlaskConical,
  Gauge,
  Plus,
  Repeat,
  Wrench,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { BlockKind } from "@/lib/types";

export const PALETTE_KINDS: readonly BlockKind[] = [
  "agent",
  "tool",
  "scenario",
  "scoring",
  "memory",
  "loop",
  "seed",
] as const;

const META: Record<
  BlockKind,
  { icon: ComponentType<{ className?: string }>; label: string; blurb: string; color: string }
> = {
  agent: {
    icon: Bot,
    label: "Agent",
    blurb: "The model under test (LangChain / OpenAI Agents / raw).",
    color: "text-emerald-400",
  },
  tool: {
    icon: Wrench,
    label: "Tool",
    blurb: "shell, file, http, or custom callable.",
    color: "text-sky-400",
  },
  scenario: {
    icon: FlaskConical,
    label: "Scenario",
    blurb: "An env class + episode count.",
    color: "text-amber-400",
  },
  scoring: {
    icon: Gauge,
    label: "Scoring",
    blurb: "Quality, adversarial, behavioural criteria.",
    color: "text-purple-400",
  },
  memory: {
    icon: Brain,
    label: "Memory",
    blurb: "none / short-term / long-term capacity.",
    color: "text-pink-400",
  },
  loop: {
    icon: Repeat,
    label: "Loop",
    blurb: "none / retry / reflexion strategy.",
    color: "text-cyan-400",
  },
  seed: {
    icon: Dice5,
    label: "Seed",
    blurb: "Deterministic seed for reproducible runs.",
    color: "text-orange-400",
  },
};

export interface PaletteProps {
  onAdd: (kind: BlockKind) => void;
}

export function Palette({ onAdd }: PaletteProps) {
  return (
    <aside
      aria-label="Block palette"
      className="hidden md:flex flex-col w-60 shrink-0 border-r border-[var(--border-default)] bg-[var(--bg-primary)] overflow-y-auto"
    >
      <div className="px-4 py-3 border-b border-[var(--border-default)]">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Blocks
        </h2>
        <p className="text-[11px] text-[var(--text-muted)] mt-1">
          Drag onto the canvas, or click to add.
        </p>
      </div>
      <div className="p-2 space-y-1.5">
        {PALETTE_KINDS.map((kind) => (
          <PaletteCard key={kind} kind={kind} onClick={() => onAdd(kind)} />
        ))}
      </div>
    </aside>
  );
}

function PaletteCard({
  kind,
  onClick,
}: {
  kind: BlockKind;
  onClick: () => void;
}) {
  const meta = META[kind];
  const Icon = meta.icon;
  const iconEl: ReactNode = <Icon className={cn("w-4 h-4", meta.color)} />;
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/eden-block", kind);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)]",
        "hover:border-[var(--accent)] hover:bg-[var(--accent-light)] transition-colors",
        "p-2.5 group",
      )}
      aria-label={`Add ${meta.label} block`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {iconEl}
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">
            {meta.label}
          </span>
        </div>
        <Plus className="w-3.5 h-3.5 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mt-1 line-clamp-2">
        {meta.blurb}
      </p>
    </button>
  );
}
