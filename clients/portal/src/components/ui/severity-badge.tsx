// ponytail: shared SeverityBadge — extracted from observability/page.tsx
// (June 2026 UI overhaul).

import { cn } from "@/lib/utils";

const CLASSES: Record<string, string> = {
  critical: "bg-[var(--error-bg)] text-[var(--error)]",
  high: "bg-[var(--warning-bg)] text-[var(--warning)]",
  medium: "bg-[var(--warning-bg)] text-[var(--warning)]",
  low: "bg-[var(--accent-faint)] text-[var(--accent)]",
  info: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        "text-xs px-2 py-0.5 rounded-full font-medium",
        CLASSES[severity] || CLASSES.info
      )}
    >
      {severity}
    </span>
  );
}
