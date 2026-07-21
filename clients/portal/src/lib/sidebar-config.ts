"use client";

/**
 * Sidebar IA — places, not verbs. Core ≤12; Advanced collapsed by default.
 *
 * Product path: Home → Observe → Evaluate → Improve → Workspace.
 * Improve core: Queue · Artifacts · Ledger · Prompts.
 * Advanced (agents, analytics, scorecard, guardrails, cost, …) behind Show Advanced.
 *
 * Group `id` values match product labels. Legacy prefs migrate in use-sidebar-prefs.
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
  BookOpen,
  Bug,
  Inbox,
  FileCode,
  Trophy,
  Sparkles,
  GitCompareArrows,
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
  /** Stable key — matches product IA label. */
  id: "home" | "observe" | "evaluate" | "improve" | "workspace";
  label: string;
  items: SidebarItem[];
}

/** Core leaf count: ≤12. Advanced items excluded from default count. */
export const DEFAULT_SIDEBAR: SidebarGroup[] = [
  {
    id: "home",
    label: "Home",
    items: [
      {
        id: "dashboard",
        href: "/dashboard",
        label: "Home",
        icon: LayoutDashboard,
        description: "Status, diagnosis, and the next action.",
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
        description: "Traces, spans, and sessions.",
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
        description: "Threshold notifications; Signals via overflow.",
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
        id: "debugger-sessions",
        href: "/debugger-sessions",
        label: "Debug sessions",
        icon: Bug,
        category: "advanced",
        description: "Multi-run debugger timeline and compare.",
      },
    ],
  },
  {
    id: "evaluate",
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
    id: "improve",
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
        description: "Institutional memory — promotions nest as a Ledger mode.",
      },
      {
        id: "prompts",
        href: "/prompts",
        label: "Prompts",
        icon: FileCode,
        description: "Version and manage prompt templates.",
      },
      {
        id: "scorecard",
        href: "/improve/scorecard",
        label: "Scorecard",
        icon: Trophy,
        category: "advanced",
        description: "Synthetic process-gate microbench — not org KPIs.",
      },
      {
        id: "online-scoring",
        href: "/improve/online-scoring",
        label: "Online scoring",
        icon: Sparkles,
        category: "advanced",
        description: "Production scorers on sampled traces.",
      },
      {
        id: "change-impact",
        href: "/improve/change-impact",
        label: "Change impact",
        icon: GitCompareArrows,
        category: "advanced",
        description: "Replay traffic before shipping prompt or model changes.",
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
        id: "optimization",
        href: "/optimization",
        label: "Cost",
        icon: CostIcon,
        category: "advanced",
        description: "Spend, budgets, outcomes, forecasts, and model advice.",
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
        description: "Chain-verified compliance packs and agent audit events.",
      },
      {
        id: "settings",
        href: "/settings",
        label: "Settings",
        icon: Settings,
        description:
          "Workspace overview, members, billing, account, gateway, retention, PII, exports.",
        children: [
          {
            id: "settings-overview",
            href: "/settings?tab=overview",
            label: "Overview",
            icon: LayoutDashboard,
            description: "Identity, plan pulse, and workspace recovery paths.",
          },
          {
            id: "api-keys",
            href: "/settings?tab=api-keys",
            label: "API keys",
            icon: KeyRound,
            description: "Org API key and org id for the SDK and gateway.",
          },
          {
            id: "settings-webhooks-dlq",
            href: "/settings?tab=webhooks-dlq",
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

/** Workspace sidebar group + overview entry complete. */
export const WS1_SIDEBAR_COMPLETED = true;

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

/** Core visible items (excludes advanced category). Cap ≤12. */
export const CORE_NAV_ITEM_COUNT = DEFAULT_SIDEBAR.flatMap((g) => g.items).filter(
  (i) => i.category !== "advanced",
).length;

/** Desktop + mobile primary five. */
export const CORE_MOBILE_HREFS = [
  "/dashboard",
  "/traces",
  "/issues",
  "/evals",
  "/improve",
] as const;
