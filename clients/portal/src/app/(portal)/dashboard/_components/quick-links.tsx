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
  Gavel,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

type QuickLinkItem = {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
  accent: "blue" | "emerald" | "amber" | "violet";
};

/**
 * ui-audit 2026-07-06 M3: QuickLinks used to render 9 identical
 * icon + label + description tiles in a uniform 2-col grid — the
 * canonical "Bootstrap icon grid" anti-pattern. Redesigned to:
 *
 *   1. Group links by intent (Build / Observe / Optimize / Admin)
 *      with a labeled section header per group.
 *   2. Vary tile size: one hero link per group (full-width, larger
 *      icon, more visual weight) + 2-3 micro links per group
 *      (compact icon + label only).
 *
 * The grouping mirrors the sidebar nav in (portal)/layout.tsx so
 * anything the user can reach from the sidebar is reachable from
 * the dashboard in the same mental model.
 */

const QUICK_LINKS: QuickLinkItem[] = [
  // Build
  {
    label: "Agents",
    description: "Manage your agent fleet",
    href: "/agents",
    icon: Bot,
    accent: "emerald",
  },
  // Observe (hero)
  {
    label: "Observability",
    description: "Trace tree, spans, telemetry",
    href: "/observability",
    icon: Activity,
    accent: "blue",
  },
  {
    label: "Alerts",
    description: "Anomaly & threshold rules",
    href: "/alerts",
    icon: BellRing,
    accent: "amber",
  },
  {
    label: "Incidents",
    description: "RCA clusters",
    href: "/incidents",
    icon: Network,
    accent: "amber",
  },
  // Optimize (hero)
  {
    label: "Optimization",
    description: "Routing, cache, cost & budget",
    href: "/optimization",
    icon: Zap,
    accent: "emerald",
  },
  {
    label: "Insights",
    description: "Patterns, KB hits, regressions",
    href: "/insights",
    icon: Sparkles,
    accent: "violet",
  },
  {
    label: "Tools",
    description: "Attribution & comparisons",
    href: "/tools",
    icon: Wrench,
    accent: "violet",
  },
  {
    label: "Judge Scores",
    description: "LLM-as-judge evaluations",
    href: "/observability/eval",
    icon: Gavel,
    accent: "violet",
  },
  // Admin
  {
    label: "Guardrails",
    description: "Policies & compliance",
    href: "/guardrails",
    icon: ShieldCheck,
    accent: "blue",
  },
];

type Group = {
  label: string;
  /** Index into QUICK_LINKS for the hero tile. */
  heroIdx: number;
  /** Remaining indices, rendered as micro tiles. */
  microIdxs: number[];
};

const GROUPS: Group[] = [
  {
    label: "Build",
    heroIdx: 0, // Agents
    microIdxs: [],
  },
  {
    label: "Observe",
    heroIdx: 1, // Observability
    microIdxs: [2, 3], // Alerts, Incidents
  },
  {
    label: "Optimize",
    heroIdx: 4, // Optimization
    microIdxs: [5, 6, 7], // Insights, Tools, Judge Scores
  },
  {
    label: "Admin",
    heroIdx: 8, // Guardrails
    microIdxs: [],
  },
];

const ACCENT_MAP: Record<QuickLinkItem["accent"], string> = {
  blue: "bg-[var(--primary-light)] text-[var(--primary)]",
  emerald: "bg-[var(--accent-light)] text-[var(--accent)]",
  amber: "bg-[var(--warning-bg)] text-[var(--warning-strong)]",
  violet: "bg-[var(--accent-faint)] text-[var(--accent)]",
};

function HeroTile({ item }: { item: QuickLinkItem }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "group flex items-center gap-3 p-4 rounded-lg",
        "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
        "hover:border-[var(--border-strong)] hover:bg-[var(--bg-tertiary)] transition-colors"
      )}
    >
      <div className={cn("p-2.5 rounded-lg shrink-0", ACCENT_MAP[item.accent])}>
        <Icon className="w-5 h-5" aria-hidden />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{item.label}</p>
        <p className="text-xs text-[var(--text-muted)] truncate">{item.description}</p>
      </div>
      <ArrowRight
        className="w-4 h-4 text-[var(--text-muted)] group-hover:text-[var(--accent)] group-hover:translate-x-0.5 transition-all shrink-0"
        aria-hidden
      />
    </Link>
  );
}

function MicroTile({ item }: { item: QuickLinkItem }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "group flex items-center gap-2 p-2 rounded-lg",
        "hover:bg-[var(--bg-secondary)] border border-transparent",
        "hover:border-[var(--border-subtle)] transition-colors"
      )}
    >
      <div className={cn("p-1.5 rounded-md shrink-0", ACCENT_MAP[item.accent])}>
        <Icon className="w-3.5 h-3.5" aria-hidden />
      </div>
      <p className="text-sm font-medium text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] truncate">
        {item.label}
      </p>
    </Link>
  );
}

export function QuickLinks() {
  return (
    <Card padding="lg">
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
          <ArrowRight className="w-3 h-3" aria-hidden />
        </Link>
      </div>
      <div className="space-y-3">
        {GROUPS.map((group) => {
          const hero = QUICK_LINKS[group.heroIdx];
          const micros = group.microIdxs.map((i) => QUICK_LINKS[i]);
          return (
            <div key={group.label}>
              {/* Terminal micro-label group header */}
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--text-muted)]">
                  {group.label}
                </span>
              </div>
              <HeroTile item={hero} />
              {micros.length > 0 && (
                <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-1 pl-1">
                  {micros.map((m) => (
                    <MicroTile key={m.href} item={m} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
