"use client";

import { ArrowUpRight, ArrowDownRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type StatCardAccent = "neutral" | "accent" | "terminal" | "warning" | "error" | "info";

export interface StatCardProps {
  /** KPI label (shown below the value as a smaller subtitle). */
  title: string;
  /** Headline value — string or number. */
  value: string | number;
  /** Optional supporting line. */
  subtitle?: string;
  /** Optional trend indicator. */
  trend?: "up" | "down" | "flat" | null;
  /** Trend delta (e.g. "+12%"). */
  trendValue?: string;
  /** Which trend direction is "good" for this stat (controls color). */
  trendIsGood?: "up" | "down";
  /** Icon shown in the top-left chip. */
  icon: React.ComponentType<{ className?: string }>;
  /** Override the icon chip's color classes. */
  iconClassName?: string;
  /** Quick accent preset — alternative to `iconClassName`. */
  accent?: StatCardAccent;
  /** Render a loading spinner in place of the value. */
  loading?: boolean;
  /** Render an empty state placeholder. */
  empty?: boolean;
  /** Empty state copy. Defaults to "No data yet". */
  emptyText?: string;
  /** Wrap the card in a clickable link. */
  href?: string;
  className?: string;
}

const ACCENT_CLASSES: Record<StatCardAccent, string> = {
  neutral: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
  accent:  "bg-[var(--accent-faint)] text-[var(--accent)]",
  terminal:"bg-[var(--terminal-faint)] text-[var(--terminal)]",
  warning: "bg-[var(--warning-bg)] text-[var(--warning)]",
  error:   "bg-[var(--error-dim)] text-[var(--error)]",
  // ponytail: `info` is a legacy alias of `accent` (same classes).
  // Kept for the one call site that already uses it; new code
  // should use `accent` directly.
  info:    "bg-[var(--accent-faint)] text-[var(--accent)]",
};

const DEFAULT_ICON_CLASS = "bg-[var(--accent-faint)] text-[var(--accent)]";

function resolveIconClass(iconClassName: string | undefined, accent: StatCardAccent | undefined): string {
  if (iconClassName) return iconClassName;
  if (accent && accent !== "neutral") return ACCENT_CLASSES[accent];
  return DEFAULT_ICON_CLASS;
}

export function StatCard({
  title,
  value,
  subtitle,
  trend,
  trendValue,
  trendIsGood = "up",
  icon: Icon,
  iconClassName,
  accent = "neutral",
  loading = false,
  empty = false,
  emptyText = "No data yet",
  href,
  className,
}: StatCardProps) {
  const inner = (
    <div
      className={cn(
        "bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)] h-full",
        "transition-all duration-200 ease-out hover:border-[var(--border-strong)] hover:shadow-md",
        className,
      )}
    >
      <div className="flex items-start justify-between mb-3">
        <div className={cn("p-2.5 rounded-lg", resolveIconClass(iconClassName, accent))}>
          <Icon className="w-5 h-5" aria-hidden />
        </div>
        {trend && trendValue && !loading && !empty && (
          <div
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded font-mono",
              trend === trendIsGood
                ? "text-[var(--terminal)] bg-[var(--terminal-faint)]"
                : "text-[var(--error)] bg-[var(--error-dim)]",
            )}
            aria-label={`${trend === "up" ? "Up" : "Down"} ${trendValue} ${trend === trendIsGood ? "(good)" : "(bad)"}`}
          >
            {trend === "up" ? (
              <ArrowUpRight className="w-3 h-3" aria-hidden />
            ) : (
              <ArrowDownRight className="w-3 h-3" aria-hidden />
            )}
            {trendValue}
          </div>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-3xl font-bold text-[var(--text-primary)] tracking-tight font-mono">
          {loading ? (
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" aria-label="Loading" />
          ) : empty ? (
            <span className="text-[var(--text-muted)]">—</span>
          ) : (
            value
          )}
        </p>
        <p className="text-sm font-medium text-[var(--text-secondary)]">{title}</p>
        {subtitle && !empty && (
          <p className="text-xs text-[var(--text-muted)] font-mono">{subtitle}</p>
        )}
        {empty && (
          <p className="text-xs text-[var(--text-muted)]">{emptyText}</p>
        )}
      </div>
    </div>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-glow)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)] rounded-xl"
      >
        {inner}
      </a>
    );
  }
  return inner;
}
