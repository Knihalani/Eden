/**
 * NodeShell — the visual frame shared by every block node on
 * the React Flow canvas. The shell is what the user *sees*; the
 * block-specific handles + summary are added by each node.
 *
 * The dark zinc-950 card with an emerald left border gives the
 * canvas a consistent "block" feel without dragging the rest
 * of the portal into dark mode.
 */

"use client";

import { Handle, Position } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type KindAccent = {
  border: string;
  ring: string;
  text: string;
  icon: string;
};

const ACCENT: Record<string, KindAccent> = {
  agent: {
    border: "border-l-emerald-500",
    ring: "ring-emerald-500/30",
    text: "text-emerald-300",
    icon: "text-emerald-400",
  },
  tool: {
    border: "border-l-sky-500",
    ring: "ring-sky-500/30",
    text: "text-sky-300",
    icon: "text-sky-400",
  },
  scenario: {
    border: "border-l-amber-500",
    ring: "ring-amber-500/30",
    text: "text-amber-300",
    icon: "text-amber-400",
  },
  scoring: {
    border: "border-l-purple-500",
    ring: "ring-purple-500/30",
    text: "text-purple-300",
    icon: "text-purple-400",
  },
  memory: {
    border: "border-l-pink-500",
    ring: "ring-pink-500/30",
    text: "text-pink-300",
    icon: "text-pink-400",
  },
  loop: {
    border: "border-l-cyan-500",
    ring: "ring-cyan-500/30",
    text: "text-cyan-300",
    icon: "text-cyan-400",
  },
  seed: {
    border: "border-l-orange-500",
    ring: "ring-orange-500/30",
    text: "text-orange-300",
    icon: "text-orange-400",
  },
};

/** Plain shape the parent passes to NodeShell for handles. */
export interface NodeHandleSpec {
  id: string;
  /** Defaults to Position.Left for inputs, Position.Right for outputs. */
  position?: Position;
}

export interface NodeShellProps {
  kind: keyof typeof ACCENT;
  label: string;
  selected?: boolean;
  icon: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  inputs?: NodeHandleSpec[];
  outputs?: NodeHandleSpec[];
  className?: string;
}

export function NodeShell({
  kind,
  label,
  selected,
  icon,
  children,
  footer,
  inputs,
  outputs,
  className,
}: NodeShellProps) {
  const accent = ACCENT[kind] ?? ACCENT.agent!;
  return (
    <div
      className={cn(
        "min-w-[180px] max-w-[260px] rounded-md border border-zinc-800 border-l-4 bg-zinc-950 shadow-md",
        accent.border,
        selected && `ring-2 ${accent.ring}`,
        className,
      )}
    >
      {inputs?.map((h, i) => (
        <Handle
          key={`in-${i}`}
          id={h.id}
          type="target"
          position={h.position ?? Position.Left}
        />
      ))}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60">
        <span className={cn("shrink-0", accent.icon)} aria-hidden="true">
          {icon}
        </span>
        <span
          className={cn(
            "text-[11px] font-semibold uppercase tracking-wider",
            accent.text,
          )}
        >
          {label}
        </span>
      </div>
      {(children || footer) && (
        <div className="px-3 py-2 text-xs text-zinc-300 space-y-1">
          {children}
          {footer && (
            <div className="pt-1 mt-1 border-t border-zinc-800/60 text-zinc-500">
              {footer}
            </div>
          )}
        </div>
      )}
      {outputs?.map((h, i) => (
        <Handle
          key={`out-${i}`}
          id={h.id}
          type="source"
          position={h.position ?? Position.Right}
        />
      ))}
    </div>
  );
}
