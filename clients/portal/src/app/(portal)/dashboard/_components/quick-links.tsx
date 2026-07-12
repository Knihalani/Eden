"use client";

import Link from "next/link";
import {
  Activity,
  Zap,
  BellRing,
  ArrowRight,
  Bot,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { InsightsIcon } from "@/components/icons/eden-nav-icons";

type Accent = "trace" | "cost" | "alert" | "agent" | "insight";

type QuickLinkItem = {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon | typeof InsightsIcon;
  accent: Accent;
};

/**
 * Portal polish: lean Quick Links — max 5 destinations, flat list.
 * No sidebar-duplicate group headers. Accents use --node-* / status
 * tokens (no violet rainbow bucket). Do not remount intelligence-grid.
 */

const QUICK_LINKS: QuickLinkItem[] = [
  {
    label: "Agents",
    description: "Manage your agent fleet",
    href: "/agents",
    icon: Bot,
    accent: "agent",
  },
  {
    label: "Observability",
    description: "Trace tree, spans, telemetry",
    href: "/observability",
    icon: Activity,
    accent: "trace",
  },
  {
    label: "Cost",
    description: "Routing, cache, budget",
    href: "/optimization",
    icon: Zap,
    accent: "cost",
  },
  {
    label: "Alerts",
    description: "Anomaly & threshold rules",
    href: "/alerts",
    icon: BellRing,
    accent: "alert",
  },
  {
    label: "Insights",
    description: "Patterns and regressions",
    href: "/insights",
    icon: InsightsIcon,
    accent: "insight",
  },
];

const ACCENT_MAP: Record<Accent, string> = {
  trace: "bg-[var(--accent-faint)] text-[var(--node-tool)]",
  cost: "bg-[var(--accent-light)] text-[var(--node-agent)]",
  alert: "bg-[var(--warning-bg)] text-[var(--warning-strong)]",
  agent: "bg-[var(--accent-faint)] text-[var(--node-agent)]",
  insight: "bg-[var(--accent-faint)] text-[var(--accent)]",
};

function LinkTile({ item }: { item: QuickLinkItem }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "group flex items-center gap-3 rounded-lg p-3",
        "border border-[var(--border-default)] bg-[var(--bg-secondary)]",
        "hover:border-[var(--border-strong)] hover:bg-[var(--bg-tertiary)] transition-colors",
      )}
    >
      <div className={cn("shrink-0 rounded-md p-2", ACCENT_MAP[item.accent])}>
        <Icon className="h-4 w-4" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--text-primary)]">{item.label}</p>
        <p className="truncate text-xs text-[var(--text-muted)]">{item.description}</p>
      </div>
      <ArrowRight
        className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-all group-hover:translate-x-0.5 group-hover:text-[var(--accent)]"
        aria-hidden
      />
    </Link>
  );
}

export function QuickLinks() {
  return (
    <Card padding="md">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Quick links</h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">Most-used surfaces</p>
        </div>
      </div>
      <div className="space-y-2">
        {QUICK_LINKS.map((item) => (
          <LinkTile key={item.href} item={item} />
        ))}
      </div>
    </Card>
  );
}
