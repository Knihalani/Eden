"use client";

import Link from "next/link";
import {
  Activity,
  Zap,
  ArrowRight,
  Key,
  BookOpen,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { AgentIcon } from "@/components/icons/eden-nav-icons";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

type Accent = "trace" | "cost" | "alert" | "agent" | "key";

type QuickLinkItem = {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon | typeof AgentIcon;
  accent: Accent;
  external?: boolean;
};

/** Install-forward first; secondary surfaces after. */
const QUICK_LINKS: QuickLinkItem[] = [
  {
    label: "API keys",
    description: "Create a key for SDK or gateway",
    href: "/settings?tab=api-keys",
    icon: Key,
    accent: "key",
  },
  {
    label: "Docs quickstart",
    description: "Install SDK or gateway, run eden-doctor",
    href: DOCS_QUICKSTART_URL,
    icon: BookOpen,
    accent: "key",
    external: true,
  },
  {
    label: "Traces",
    description: "Inspect every AI call",
    href: "/traces",
    icon: Activity,
    accent: "trace",
  },
  {
    label: "Agents",
    description: "Manage your agent fleet",
    href: "/agents",
    icon: AgentIcon,
    accent: "agent",
  },
  {
    label: "Artifacts",
    description: "Shadow fixes & promotion",
    href: "/artifacts",
    icon: Activity,
    accent: "trace",
  },
  {
    label: "Scorecard",
    description: "Evolution lift & cost gates",
    href: "/improve/scorecard",
    icon: Zap,
    accent: "cost",
  },
  {
    label: "Cost",
    description: "Routing, cache, budget",
    href: "/optimization",
    icon: Zap,
    accent: "cost",
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
  const className = cn(
    "group flex items-start gap-3 rounded-xl border border-[var(--border-default)]",
    "bg-[var(--bg-primary)] p-3 min-h-[44px] transition-colors hover:border-[var(--accent)]/40 hover:bg-[var(--bg-secondary)]",
  );
  const body = (
    <>
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
    </>
  );
  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {body}
      </a>
    );
  }
  return (
    <Link href={item.href} className={className}>
      {body}
    </Link>
  );
}

export function QuickLinks() {
  return (
    <Card padding="md" className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">
        Quick links
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
        {QUICK_LINKS.map((item) => (
          <LinkTile key={item.href} item={item} />
        ))}
      </div>
    </Card>
  );
}
