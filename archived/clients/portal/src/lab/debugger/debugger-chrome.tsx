"use client";

import Link from "next/link";
import { StatusChip } from "@/components/ds/primitives";
import {
  modeSubtitle,
  type DebuggerMode,
} from "@/lab/fixtures/debugger";
import { cn } from "@/lib/utils";

export function parseDebuggerMode(mode: string | null): DebuggerMode {
  if (mode === "compare") return "compare";
  if (mode === "inspect") return "inspect";
  if (mode === "time-travel") return "time-travel";
  if (mode === "replay") return "replay";
  return "replay";
}

export function modeToParam(mode: DebuggerMode): string {
  return mode;
}

/** Segmented control — clearly clickable, not plain text. */
export function DebuggerModeNav({
  value,
  onChange,
}: {
  value: DebuggerMode;
  onChange: (next: DebuggerMode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="How to investigate"
      className="inline-flex rounded-[var(--radius)] p-0.5 shadow-[inset_0_0_0_1px_var(--line)]"
    >
      {(
        [
          ["replay", "Replay"],
          ["compare", "Compare"],
          ["inspect", "Inspect"],
          ["time-travel", "Time travel"],
        ] as const
      ).map(([id, label]) => {
        const selected = value === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            title={modeSubtitle(id)}
            aria-selected={selected}
            className={cn(
              "type-meta rounded-[calc(var(--radius)-2px)] px-3 py-1.5 transition-colors",
              selected
                ? "bg-[var(--accent-muted)] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--accent)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
            )}
            onClick={() => onChange(id)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function DebuggerOutcomeChip({
  outcome,
}: {
  outcome: "ok" | "error";
}) {
  return (
    <StatusChip tone={outcome === "ok" ? "ok" : "fail"}>
      {outcome === "ok" ? "OK" : "Failed"}
    </StatusChip>
  );
}

/** Clear back control for the detail header. */
export function DebuggerBackLink({
  href,
  label = "All sessions",
}: {
  href: string;
  label?: string;
}) {
  return (
    <Link href={href} className="ds-btn ds-btn-ghost ds-btn-sm">
      {label}
    </Link>
  );
}
