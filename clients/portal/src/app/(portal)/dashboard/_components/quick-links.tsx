"use client";

import Link from "next/link";
import {
  Activity,
  Zap,
  BellRing,
  Sparkles,
  ArrowRight,
  Bot,
  ShieldCheck,
  Wrench,
  Network,
} from "lucide-react";
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
    label: "Agents",
    description: "Manage your agent fleet",
    href: "/agents",
    icon: Bot,
    accent: "emerald",
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
    label: "Tools",
    description: "Attribution & comparisons",
    href: "/tools",
    icon: Wrench,
    accent: "violet",
  },
  {
    label: "Insights",
    description: "Patterns, KB hits, regressions",
    href: "/insights",
    icon: Sparkles,
    accent: "violet",
  },
  {
    label: "Guardrails",
    description: "Policies & compliance",
    href: "/guardrails",
    icon: ShieldCheck,
    accent: "blue",
  },
  {
    label: "Incidents",
    description: "RCA clusters",
    href: "/incidents",
    icon: Network,
    accent: "amber",
  },
];

const ACCENT_MAP: Record<QuickLinkItem["accent"], string> = {
  blue: "bg-[var(--primary-light)] text-[var(--primary)]",
  emerald: "bg-[var(--accent-light)] text-[var(--accent)]",
  amber: "bg-[var(--warning-bg)] text-[var(--warning-strong)]",
  violet: "bg-[var(--accent-faint)] text-[var(--accent)]",
};

export function QuickLinks() {
  return (
    <div className="bg-[var(--bg-primary)] rounded-xl p-5 border border-[var(--border-default)]">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--text-primary)]">Quick links</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">Jump to the most-used surfaces</p>
        </div>
        <Link
          href="/insights"
          className="text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] inline-flex items-center gap-1"
        >
          Insights
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
              <p className="text-sm font-medium text-[var(--text-primary)] truncate">{q.label}</p>
              <p className="text-xs text-[var(--text-muted)] truncate">{q.description}</p>
            </div>
            <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--accent)] group-hover:translate-x-0.5 transition-all shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}
