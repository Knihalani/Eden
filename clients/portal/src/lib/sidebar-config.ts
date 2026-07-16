"use client";

/**
 * Sidebar config — 12 top-level surfaces (July 2026 consolidation).
 *
 * Deep links (agent detail, issue detail, plan detail) stay routable
 * but are not nav items. Connect lives as a CTA on Agents.
 */

import type { ComponentType } from "react";
import {
  LayoutDashboard,
  Settings,
  FileText,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import {
  TraceIcon,
  EvalIcon,
  CostIcon,
  AgentIcon,
  PatchIcon,
  GuardrailIcon,
  AlertNavIcon,
  InsightsIcon,
} from "@/components/icons/eden-nav-icons";
import { DOCS_URL } from "@/lib/constants";

export type SidebarIcon = LucideIcon | ComponentType<{ className?: string }>;

export interface SidebarItem {
  id: string;
  href: string;
  label: string;
  icon: SidebarIcon;
  description?: string;
  badge?: string;
  children?: SidebarItem[];
  category?: "core" | "advanced";
}

export interface SidebarGroup {
  id: "build" | "observe" | "optimize" | "automate" | "workspace";
  label: string;
  items: SidebarItem[];
}

export const DEFAULT_SIDEBAR: SidebarGroup[] = [
  {
    id: "build",
    label: "Build",
    items: [
      {
        id: "dashboard",
        href: "/dashboard",
        label: "Dashboard",
        icon: LayoutDashboard,
        description: "One-glance view of agents, traces, costs, and alerts.",
      },
      {
        id: "agents",
        href: "/agents",
        label: "Agents",
        icon: AgentIcon,
        description: "Manage AI agents and fleet health. Connect repos from here.",
      },
      {
        id: "prompts",
        href: "/prompts",
        label: "Prompts",
        icon: FileText,
        description: "Version and manage prompt templates.",
      },
    ],
  },
  {
    id: "observe",
    label: "Observe",
    items: [
      {
        id: "traces",
        href: "/traces",
        label: "Traces",
        icon: TraceIcon,
        description: "Every AI call — inspect, replay, and debug from one place.",
      },
      {
        id: "issues",
        href: "/issues",
        label: "Issues",
        icon: ShieldAlert,
        description: "Grouped failures and incident clusters.",
      },
      {
        id: "alerts",
        href: "/alerts",
        label: "Alerts",
        icon: AlertNavIcon,
        description: "Threshold notifications and custom signal rules.",
      },
      {
        id: "analytics",
        href: "/analytics",
        label: "Analytics",
        icon: InsightsIcon,
        description: "Usage, tools, users, and trend insights.",
      },
      {
        id: "evals",
        href: "/evals",
        label: "Evals",
        icon: EvalIcon,
        description: "Datasets, labeling, studio metrics, and synthetic data.",
      },
    ],
  },
  {
    id: "optimize",
    label: "Optimize",
    items: [
      {
        id: "improve",
        href: "/improve",
        label: "Improve",
        icon: PatchIcon,
        description: "Action queue, improvement plans, and sweep history.",
      },
      {
        id: "optimization",
        href: "/optimization",
        label: "Cost",
        icon: CostIcon,
        description: "Spend, budgets, outcomes, forecasts, and model advice.",
      },
      {
        id: "guardrails",
        href: "/guardrails",
        label: "Guardrails",
        icon: GuardrailIcon,
        description: "Safety policies and red-team tests.",
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        id: "settings",
        href: "/settings",
        label: "Settings",
        icon: Settings,
        description: "Members, billing, account, gateway, retention, PII, exports.",
        children: [
          {
            id: "settings-webhooks-dlq",
            href: "/settings/webhooks-dlq",
            label: "Webhook DLQ",
            icon: Settings,
            category: "advanced",
            description: "Replay terminal-state webhook deliveries.",
          },
        ],
      },
      {
        id: "docs",
        href: DOCS_URL,
        label: "Docs",
        icon: FileText,
        description: "API reference, guides, and examples.",
      },
    ],
  },
];

export const ALL_ITEM_IDS: string[] = (() => {
  const out: string[] = [];
  for (const group of DEFAULT_SIDEBAR) {
    for (const item of group.items) {
      out.push(item.id);
      if (item.children) {
        for (const child of item.children) out.push(child.id);
      }
    }
  }
  return out;
})();
