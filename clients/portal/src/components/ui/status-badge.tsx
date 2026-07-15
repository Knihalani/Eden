"use client";

import * as _React from "react";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Circle, Clock, Info, LucideIcon, XCircle } from "lucide-react";
import { STATUS, OUTCOMES, PR_STATUSES, IMPROVEMENT_PLAN_STATUSES, type StatusDescriptor, type OutcomeDescriptor } from "@/lib/types";

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

/** Per-trace outcome states (success/failure/partial/timeout/crash/unknown). */
type TraceOutcome = "success" | "failure" | "partial" | "timeout" | "crash" | "unknown";

interface TraceOutcomeBadgeProps {
  outcome: TraceOutcome | string | null;
  className?: string;
}

const TRACE_OUTCOME_CLASSES: Record<string, string> = {
  success: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
  failure: "bg-[var(--error-bg)] text-[var(--error)]",
  partial: "bg-[var(--warning-bg)] text-[var(--warning)]",
  timeout: "bg-[var(--warning-bg)] text-[var(--warning)]",
  crash: "bg-[var(--error-dim)] text-[var(--error)]",
  unknown: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" };

const TRACE_OUTCOME_ICONS: Record<string, LucideIcon> = {
  success: CheckCircle2,
  failure: XCircle,
  partial: AlertTriangle,
  timeout: Clock,
  crash: XCircle,
  unknown: Circle };

const SEVERITY_CLASSES: Record<string, string> = {
  critical: "bg-[var(--error-bg)] text-[var(--error)]",
  high: "bg-[var(--warning-bg)] text-[var(--warning)]",
  medium: "bg-[var(--warning-bg)] text-[var(--warning)]",
  low: "bg-[var(--accent-faint)] text-[var(--accent)]",
  info: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" };

const SEVERITY_ICON_FOR_BADGE: Record<string, LucideIcon> = {
  critical: XCircle,
  high: AlertTriangle,
  medium: AlertTriangle,
  low: Info,
  info: Info };

function resolveStatus(
  status: string,
  descriptors: Record<string, StatusDescriptor> | undefined,
): StatusDescriptor {
  const map = descriptors ?? STATUS;
  return map[status] ?? {
    label: status,
    className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
    icon: Clock };
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

/** N23 improvement plan statuses. */
export function ImprovePlanStatusBadge(props: Omit<StatusBadgeProps, "descriptors">) {
  return <StatusBadge {...props} descriptors={IMPROVEMENT_PLAN_STATUSES} />;
}

/**
 * Generic icon + text badge for any outcome key in `OUTCOMES`.
 */
export function OutcomeBadge({ outcome, className, iconOnly = false }: OutcomeBadgeProps) {
  const desc: OutcomeDescriptor = OUTCOMES[outcome] ?? {
    label: outcome,
    className: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border-default)]",
    icon: Circle };
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

/**
 * Per-trace outcome badge (success / failure / partial / timeout / crash / unknown).
 * Distinct from `OutcomeBadge` which maps to OUTCOMES tiers (gold/silver/bronze).
 */
export function TraceOutcomeBadge({ outcome, className }: TraceOutcomeBadgeProps) {
  const key = outcome || "unknown";
  const Icon = TRACE_OUTCOME_ICONS[key] || TRACE_OUTCOME_ICONS.unknown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium",
        TRACE_OUTCOME_CLASSES[key] || TRACE_OUTCOME_CLASSES.unknown,
        className,
      )}
      role="status"
      aria-label={`Trace outcome: ${key}`}
    >
      <Icon className="h-3 w-3 flex-shrink-0" aria-hidden />
      {key}
    </span>
  );
}

/**
 * Severity badge for incidents and alerts (critical / high / medium / low / info).
 */
export function SeverityBadge({ severity, className }: { severity: string; className?: string }) {
  const key = severity || "info";
  const Icon = SEVERITY_ICON_FOR_BADGE[key] || Info;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium capitalize",
        SEVERITY_CLASSES[key] || SEVERITY_CLASSES.info,
        className,
      )}
      role="status"
      aria-label={`Severity: ${key}`}
    >
      <Icon className="h-3 w-3 flex-shrink-0" aria-hidden />
      {key}
    </span>
  );
}

const SEVERITY_ICON_MAP: Record<string, { icon: LucideIcon; color: string }> = {
  critical: { icon: XCircle, color: "text-[var(--error)]" },
  high: { icon: AlertTriangle, color: "text-[var(--warning)]" },
  medium: { icon: AlertTriangle, color: "text-[var(--warning)]" },
  low: { icon: Info, color: "text-[var(--accent)]" },
  info: { icon: Info, color: "text-[var(--text-muted)]" } };

/**
 * Severity icon — a colored icon-only signal for severity levels.
 * Companion to `SeverityBadge` for surfaces that want a glyph
 * without a label (e.g. table rows, compact lists).
 */
export function SeverityIcon({
  severity,
  className }: {
  severity: string;
  className?: string;
}) {
  const { icon: Icon, color } = SEVERITY_ICON_MAP[severity] || SEVERITY_ICON_MAP.info;
  return (
    <Icon
      className={cn("w-5 h-5 flex-shrink-0", color, className)}
      aria-label={`Severity: ${severity}`}
    />
  );
}
