"use client";

import { Loader2, ArrowUpRight, ArrowDownRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: "up" | "down" | null;
  trendValue?: string;
  trendIsGood?: "up" | "down";
  icon: LucideIcon;
  iconClassName?: string;
  loading?: boolean;
  href?: string;
  empty?: boolean;
  emptyText?: string;
}

export function StatCard({
  title,
  value,
  subtitle,
  trend,
  trendValue,
  trendIsGood = "up",
  icon: Icon,
  iconClassName = "bg-[var(--accent-light)] text-[var(--accent)]",
  loading = false,
  href,
  empty = false,
  emptyText = "No data yet",
}: StatCardProps) {
  const inner = (
    <div className="bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)] h-full transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between mb-3">
        <div className={cn("p-2.5 rounded-lg", iconClassName)}>
          <Icon className="w-5 h-5" />
        </div>
        {trend && trendValue && !loading && !empty && (
          <div
            className={cn(
              "flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded",
              (trend === trendIsGood)
                ? "text-[var(--success)] bg-[var(--success-bg)]"
                : "text-[var(--error)] bg-[var(--error-bg)]"
            )}
          >
            {trend === "up" ? (
              <ArrowUpRight className="w-3 h-3" />
            ) : (
              <ArrowDownRight className="w-3 h-3" />
            )}
            {trendValue}
          </div>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
          {loading ? (
            <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
          ) : empty ? (
            <span className="text-[var(--text-muted)]">—</span>
          ) : (
            value
          )}
        </p>
        <p className="text-sm font-medium text-[var(--text-secondary)]">{title}</p>
        {subtitle && !empty && (
          <p className="text-xs text-[var(--text-muted)]">{subtitle}</p>
        )}
        {empty && (
          <p className="text-xs text-[var(--text-muted)]">{emptyText}</p>
        )}
      </div>
    </div>
  );

  if (href) {
    return (
      <a href={href} className="block transition-transform hover:-translate-y-0.5">
        {inner}
      </a>
    );
  }
  return inner;
}
