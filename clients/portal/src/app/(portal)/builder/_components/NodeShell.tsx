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
    text: "text-[var(--terminal)]",
    icon: "text-[var(--terminal)]",
  },
  tool: {
    border: "border-l-sky-500",
    ring: "ring-sky-500/30",
    text: "text-[var(--accent)]",
    icon: "text-[var(--accent)]",
  },
  scenario: {
    border: "border-l-amber-500",
    ring: "ring-amber-500/30",
    text: "text-[var(--warning)]",
    icon: "text-[var(--warning)]",
  },
  scoring: {
    border: "border-l-purple-500",
    ring: "ring-purple-500/30",
    text: "text-[var(--accent)]",
    icon: "text-[var(--accent)]",
  },
  memory: {
    border: "border-l-pink-500",
    ring: "ring-pink-500/30",
    text: "text-[var(--accent)]",
    icon: "text-[var(--accent)]",
  },
  loop: {
    border: "border-l-cyan-500",
    ring: "ring-cyan-500/30",
    text: "text-[var(--accent)]",
    icon: "text-[var(--accent)]",
  },
  seed: {
    border: "border-l-orange-500",
    ring: "ring-orange-500/30",
    text: "text-[var(--warning)]",
    icon: "text-[var(--warning)]",
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
        "min-w-[180px] max-w-[260px] rounded-md border border-[var(--border-default)] bg-[var(--bg-base)] shadow-md",
        // ui-audit 2026-07-06: the 4px left "colored stripe" was a
        // SaaS cliché tell. Move type identity to the header chip and
        // use a thin 2px accent strip as a selected-only affordance
        // (which matches the `ring-2 ring-…` already on selection).
        selected ? `border-l-2 ${accent.border} ring-2 ${accent.ring}` : null,
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
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-default)]/60">
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
        <div className="px-3 py-2 text-xs text-[var(--text-muted)] space-y-1">
          {children}
          {footer && (
            <div className="pt-1 mt-1 border-t border-[var(--border-default)]/60 text-[var(--text-muted)]">
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
