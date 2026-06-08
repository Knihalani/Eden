"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Skeleton } from "./skeleton";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";

export type StatCardAccent = "neutral" | "accent" | "warning" | "terminal" | "error" | "info";

export interface StatCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: StatCardAccent;
  trend?: "up" | "down" | "flat";
  trendValue?: string;
  isLoading?: boolean;
  href?: string;
  className?: string;
}

const ACCENT_STYLES: Record<StatCardAccent, { chip: string; dot: string; trend: string }> = {
  neutral: {
    chip: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
    dot: "bg-[var(--text-muted)]",
    trend: "text-[var(--text-muted)]",
  },
  accent: {
    chip: "bg-[var(--accent-faint)] text-[var(--accent)]",
    dot: "bg-[var(--accent)]",
    trend: "text-[var(--accent)]",
  },
  warning: {
    chip: "bg-[var(--warning-bg)] text-[var(--warning)]",
    dot: "bg-[var(--warning)]",
    trend: "text-[var(--warning)]",
  },
  terminal: {
    chip: "bg-[var(--terminal-faint)] text-[var(--terminal)]",
    dot: "bg-[var(--terminal)]",
    trend: "text-[var(--terminal)]",
  },
  error: {
    chip: "bg-[var(--error-bg)] text-[var(--error)]",
    dot: "bg-[var(--error)]",
    trend: "text-[var(--error)]",
  },
  info: {
    chip: "bg-[var(--accent-faint)] text-[var(--accent)]",
    dot: "bg-[var(--accent)]",
    trend: "text-[var(--accent)]",
  },
};

const TREND_ICON = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: Minus,
};

function StatCardContent({
  label,
  value,
  subtitle,
  icon: Icon,
  accent = "neutral",
  trend,
  trendValue,
  isLoading,
}: Omit<StatCardProps, "href" | "className">) {
  const styles = ACCENT_STYLES[accent];
  const TrendIcon = trend ? TREND_ICON[trend] : null;

  return (
    <div className="group relative">
      <div
        className={cn(
          "absolute left-0 top-0 bottom-0 w-[3px] rounded-full transition-opacity",
          styles.dot,
          "opacity-0 group-hover:opacity-100",
        )}
        aria-hidden
      />
      <div className="pl-4">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
            {label}
          </span>
          <div className={cn("p-1 rounded", styles.chip)}>
            <Icon className="w-3 h-3" />
          </div>
        </div>
        <div className="flex items-baseline gap-2">
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <p className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
              {value}
            </p>
          )}
          {trend && TrendIcon && !isLoading && (
            <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", styles.trend)}>
              <TrendIcon className="w-3 h-3" />
              {trendValue}
            </span>
          )}
        </div>
        {subtitle && (
          <p className="text-xs text-[var(--text-muted)] mt-0.5">{subtitle}</p>
        )}
      </div>
    </div>
  );
}

export function StatCard(props: StatCardProps) {
  const { href, className, ...rest } = props;

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          "block rounded-xl p-2 -m-2 transition-colors hover:bg-[var(--bg-tertiary)]/40",
          className,
        )}
      >
        <StatCardContent {...rest} />
      </Link>
    );
  }

  return (
    <div className={className}>
      <StatCardContent {...rest} />
    </div>
  );
}
