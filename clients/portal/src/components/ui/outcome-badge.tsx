// ponytail: shared OutcomeBadge — extracted from observability/page.tsx
// (June 2026 UI overhaul) so /traces, /observability, and the per-sub-
// route pages render traces consistently.

import { cn } from "@/lib/utils";
import type { Outcome } from "@/app/(portal)/observability/_lib/types";

const CLASSES: Record<string, string> = {
  success: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
  failure: "bg-[var(--error-bg)] text-[var(--error)]",
  partial: "bg-[var(--warning-bg)] text-[var(--warning)]",
  timeout: "bg-[var(--warning-bg)] text-[var(--warning)]",
  crash: "bg-[var(--error-dim)] text-[var(--error)]",
  unknown: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
};

export function OutcomeBadge({ outcome }: { outcome: Outcome | string | null }) {
  const key = outcome || "unknown";
  return (
    <span
      className={cn(
        "text-xs px-2 py-0.5 rounded-full font-medium",
        CLASSES[key] || CLASSES.unknown
      )}
    >
      {key}
    </span>
  );
}
