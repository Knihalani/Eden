"use client";

import Link from "next/link";
import {
  Activity,
  Zap,
  BellRing,
  ArrowRight,
  Key,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { AgentIcon } from "@/components/icons/eden-nav-icons";

type Accent = "trace" | "cost" | "alert" | "agent" | "key";

type QuickLinkItem = {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon | typeof AgentIcon;
  accent: Accent;
};

const QUICK_LINKS: QuickLinkItem[] = [
  {
    label: "API keys",
    description: "Create a key for the SDK",
    href: "/settings?tab=api-keys",
    icon: Key,
    accent: "key",
  },
  {
    label: "Agents",
    description: "Manage your agent fleet",
    href: "/agents",
    icon: AgentIcon,
    accent: "agent",
  },
  {
    label: "Traces",
    description: "Inspect every AI call",
    href: "/traces",
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
];

const ACCENT_MAP: Record<Accent, string> = {
  trace: "bg-[var(--accent-faint)] text-[var(--node-tool)]",
  cost: "bg-[var(--accent-light)] text-[var(--node-agent)]",
  alert: "bg-[var(--warning-bg)] text-[var(--warning-strong)]",
  agent: "bg-[var(--accent-faint)] text-[var(--node-agent)]",
  key: "bg-[var(--accent-faint)] text-[var(--accent)]",
};

function LinkTile({ item }: { item: QuickLinkItem }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "group flex items-start gap-3 rounded-xl border border-[var(--border-default)]",
        "bg-[var(--bg-primary)] p-3 transition-colors hover:border-[var(--accent)]/40 hover:bg-[var(--bg-secondary)]",
      )}
    >
      <span
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          ACCENT_MAP[item.accent],
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm font-medium text-[var(--text-primary)]">
          {item.label}
          <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
        </span>
        <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
          {item.description}
        </span>
      </span>
    </Link>
  );
}

export function QuickLinks() {
  return (
    <Card padding="md" className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Quick links</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
        {QUICK_LINKS.map((item) => (
          <LinkTile key={item.href} item={item} />
        ))}
      </div>
    </Card>
  );
}
