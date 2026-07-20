"use client";

/**
 * U12 IA freeze — ≤12 core nav items (July 2026 Wave 3 / Wave 4 foundation).
 *
 * Product path order: Home → Observe → Evaluate → Improve → Workspace.
 * Advanced surfaces (agents, prompts, analytics, guardrails, cost) stay
 * behind the Advanced toggle until expanded.
 *
 * Group `id` values are stable keys (legacy); display labels live on
 * `label` and in `GROUP_LABEL` (nav-commands). Do not rename ids without
 * migrating breadcrumb category maps.
 */

import type { ComponentType } from "react";
import {
  LayoutDashboard,
  Settings,
  FileText,
  ShieldAlert,
  ShieldCheck,
  KeyRound,
  Package,
  TrendingUp,
  BookOpen,
  Radio,
  Bug,
  Inbox,
  FileCode,
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
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

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
  /** Stable key — display via `label` / GROUP_LABEL, not this id. */
  id: "build" | "observe" | "optimize" | "automate" | "workspace";
  label: string;
  items: SidebarItem[];
}

/** Core leaf count: ≤12 per U12. Advanced items excluded from default count. */
export const DEFAULT_SIDEBAR: SidebarGroup[] = [
  {
    id: "build",
    label: "Home",
    items: [
      {
        id: "dashboard",
        href: "/dashboard",
        label: "Home",
        icon: LayoutDashboard,
        description: "One-glance view of agents, traces, costs, and alerts.",
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
        description: "Traces, spans, and sessions — inspect without leaving the hub.",
      },
      {
        id: "issues",
        href: "/issues",
        label: "Agent Issues",
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
        id: "agents",
        href: "/agents",
        label: "Agents",
        icon: AgentIcon,
        category: "advanced",
        description: "Manage AI agents and fleet health.",
      },
      {
        id: "analytics",
        href: "/analytics",
        label: "Analytics",
        icon: InsightsIcon,
        category: "advanced",
        description: "Usage, tools, users, and trend insights.",
      },
      {
        id: "signals",
        href: "/alerts?tab=signals",
        label: "Signals",
        icon: Radio,
        category: "advanced",
        description: "Deep search signals and classifier rules.",
      },
      {
        id: "debugger-sessions",
        href: "/debugger-sessions",
        label: "Debug sessions",
        icon: Bug,
        category: "advanced",
        description: "Multi-run debugger timeline and compare (F74).",
      },
    ],
  },
  {
    id: "automate",
    label: "Evaluate",
    items: [
      {
        id: "evals",
        href: "/evals",
        label: "Evals",
        icon: EvalIcon,
        description: "Playgrounds, experiments, datasets, labeling, and studio.",
      },
    ],
  },
  {
    id: "optimize",
    label: "Improve",
    items: [
      {
        id: "improve",
        href: "/improve",
        label: "Improve",
        icon: PatchIcon,
        description: "Action queue, improvement plans, and sweep history.",
      },
      {
        id: "artifacts",
        href: "/artifacts",
        label: "Artifacts",
        icon: Package,
        description: "Versioned runtime fixes with evidence-gated promotion.",
      },
      {
        id: "ledger",
        href: "/ledger",
        label: "Ledger",
        icon: BookOpen,
        description: "Compounding institutional memory for your agents.",
      },
      {
        id: "promotions",
        href: "/promotions",
        label: "Promotions",
        icon: TrendingUp,
        description: "EvidenceGate inbox — approve or reject shadow candidates.",
      },
      {
        id: "optimization",
        href: "/optimization",
        label: "Cost",
        icon: CostIcon,
        category: "advanced",
        description: "Spend, budgets, outcomes, forecasts, and model advice.",
      },
      {
        id: "guardrails",
        href: "/guardrails",
        label: "Guardrails",
        icon: GuardrailIcon,
        category: "advanced",
        description: "Safety policies and red-team tests.",
      },
      {
        id: "prompts",
        href: "/prompts",
        label: "Prompts",
        icon: FileCode,
        category: "advanced",
        description: "Version and manage prompt templates.",
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        id: "audit-trail",
        href: "/audit-trail",
        label: "Audit trail",
        icon: ShieldCheck,
        description: "Chain-verified compliance packs and agent audit events (N06).",
      },
      {
        id: "settings",
        href: "/settings",
        label: "Settings",
        icon: Settings,
        description: "Members, billing, account, gateway, retention, PII, exports.",
        children: [
          {
            id: "api-keys",
            href: "/settings?tab=api-keys",
            label: "API keys",
            icon: KeyRound,
            description: "Org API key and org id for the SDK and gateway.",
          },
          {
            id: "settings-webhooks-dlq",
            href: "/settings/webhooks-dlq",
            label: "Webhook DLQ",
            icon: Inbox,
            category: "advanced",
            description: "Replay terminal-state webhook deliveries.",
          },
        ],
      },
      {
        id: "docs",
        href: DOCS_QUICKSTART_URL,
        label: "Quickstart",
        icon: FileText,
        description: "Docs quickstart — gateway or SDK, then send a first trace.",
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

/** U12 core visible items (excludes advanced category). */
export const CORE_NAV_ITEM_COUNT = DEFAULT_SIDEBAR.flatMap((g) => g.items).filter(
  (i) => i.category !== "advanced",
).length;
