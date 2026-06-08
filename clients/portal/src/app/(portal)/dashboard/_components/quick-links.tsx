"use client";

import Link from "next/link";
import { Activity, Zap, BellRing, Sparkles, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface QuickLinkItem {
  label: string;
  description: string;
  href: string;
  icon: typeof Activity;
  accent: "blue" | "emerald" | "amber" | "violet";
}

const QUICK_LINKS: QuickLinkItem[] = [
  {
    label: "Observability",
    description: "Trace tree, spans, telemetry",
    href: "/observability",
    icon: Activity,
    accent: "blue",
  },
  {
    label: "Optimization",
    description: "Routing, cache, cost & budget",
    href: "/optimization",
    icon: Zap,
    accent: "emerald",
  },
  {
    label: "Alerts",
    description: "Anomaly & threshold rules",
    href: "/alerts",
    icon: BellRing,
    accent: "amber",
  },
  {
    label: "Insights",
    description: "Patterns, KB hits, regressions",
    href: "/insights",
    icon: Sparkles,
    accent: "violet",
  },
];

const ACCENT_MAP: Record<QuickLinkItem["accent"], string> = {
  blue: "bg-[var(--primary-light)] text-[var(--primary)]",
  emerald: "bg-[var(--accent-light)] text-[var(--accent)]",
  amber: "bg-[var(--warning-bg)] text-[var(--warning-strong)]",
  violet: "bg-violet-50 text-violet-600",
};

export function QuickLinks() {
  return (
    <div className="bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)]">
      <h2 className="text-base font-semibold text-[var(--text-primary)] mb-4">Quick Links</h2>
      <div className="space-y-2">
        {QUICK_LINKS.map((q) => (
          <Link
            key={q.href}
            href={q.href}
            className="flex items-center gap-3 p-3 rounded-lg hover:bg-[var(--bg-secondary)] border border-transparent hover:border-[var(--border-subtle)] transition-all group"
          >
            <div className={cn("p-2 rounded-lg shrink-0", ACCENT_MAP[q.accent])}>
              <q.icon className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[var(--text-primary)]">{q.label}</p>
              <p className="text-xs text-[var(--text-muted)] truncate">{q.description}</p>
            </div>
            <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--accent)] group-hover:translate-x-0.5 transition-all shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}
