"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Clock, Circle } from "lucide-react";
import { STATUS, OUTCOMES, PR_STATUSES, type StatusDescriptor, type OutcomeDescriptor } from "@/lib/types";

interface StatusBadgeProps {
  status: string;
  /** Render the running-state icon with a subtle spin. */
  animated?: boolean;
  className?: string;
  /** When true, render icon-only (still accessible via aria-label). */
  iconOnly?: boolean;
  /** Override the descriptor map (e.g. PR_STATUSES). Defaults to STATUS. */
  descriptors?: Record<string, StatusDescriptor>;
}

interface OutcomeBadgeProps {
  outcome: string;
  className?: string;
  iconOnly?: boolean;
}

function resolveStatus(
  status: string,
  descriptors: Record<string, StatusDescriptor> | undefined,
): StatusDescriptor {
  const map = descriptors ?? STATUS;
  return map[status] ?? {
    label: status,
    className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
    icon: Clock,
  };
}

/**
 * Generic icon + text badge for any status key in `STATUS` (or a custom descriptor map).
 * Color is one of three signals — icon and label are the primary signals.
 */
export function StatusBadge({ status, animated = false, className, iconOnly = false, descriptors }: StatusBadgeProps) {
  const desc = resolveStatus(status, descriptors);
  const Icon = desc.icon;
  const isAnimated = animated && status === "running";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border border-current/10",
        desc.className,
        className,
      )}
      role="status"
      aria-label={desc.label}
    >
      <Icon
        className={cn("w-3 h-3 flex-shrink-0", isAnimated && "animate-spin")}
        aria-hidden
      />
      {!iconOnly && <span>{desc.label}</span>}
    </span>
  );
}

/** Convenience wrapper for PR-suggestion statuses. */
export function PRStatusBadge(props: Omit<StatusBadgeProps, "descriptors">) {
  return <StatusBadge {...props} descriptors={PR_STATUSES} />;
}

/**
 * Generic icon + text badge for any outcome key in `OUTCOMES`.
 */
export function OutcomeBadge({ outcome, className, iconOnly = false }: OutcomeBadgeProps) {
  const desc: OutcomeDescriptor = OUTCOMES[outcome] ?? {
    label: outcome,
    className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-default)]",
    icon: Circle,
  };
  const Icon = desc.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border",
        desc.className,
        className,
      )}
      role="status"
      aria-label={desc.label}
    >
      <Icon className="w-3 h-3 flex-shrink-0" aria-hidden />
      {!iconOnly && <span>{desc.label}</span>}
    </span>
  );
}
