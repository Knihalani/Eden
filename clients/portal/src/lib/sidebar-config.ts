"use client";

/**
 * Sidebar config — the single source of truth for the portal's left nav.
 *
 * Every item has a stable `id` so user customisations (pinned / hidden /
 * reordered) can refer to it without coupling to the href. New routes
 * should be added here (not inline in layout.tsx) so the Settings → Sidebar
 * tab and the command palette pick them up automatically.
 *
 * The default order is hard-coded; per-user customisation is layered on
 * top via useSidebarPrefs (see src/hooks/use-sidebar-prefs.ts).
 *
 * Phase 1 of the June 2026 UI overhaul replaces the hard-coded nav groups
 * in (portal)/layout.tsx with this data-driven config.
 */

import {
  LayoutDashboard,
  Bot,
  Wand2,
  Box,
  Network,
  Server,
  Layers,
  PlayCircle,
  Activity,
  GitBranch,
  Database,
  Compass,
  BarChart3,
  Brain,
  Sparkles,
  History,
  Wrench,
  AlertOctagon,
  Bell,
  Cog,
  FlaskConical,
  Shield,
  Inbox,
  GitPullRequestArrow,
  Settings,
  Users,
  CreditCard,
  FileText,
  User,
  type LucideIcon,
} from "lucide-react";

export interface SidebarItem {
  /** Stable id for customisation (pin / hide / reorder). */
  id: string;
  /** Path the item links to. */
  href: string;
  /** Display label. */
  label: string;
  /** Lucide icon component. */
  icon: LucideIcon;
  /** Optional badge text shown next to the label (e.g. "new", "beta"). */
  badge?: string;
  /** Nested items (rendered as a sub-group under the parent). */
  children?: SidebarItem[];
}

export interface SidebarGroup {
  id: "build" | "observe" | "optimize" | "automate" | "admin";
  label: string;
  items: SidebarItem[];
}

export const DEFAULT_SIDEBAR: SidebarGroup[] = [
  {
    id: "build",
    label: "Build",
    items: [
      { id: "dashboard",   href: "/dashboard",    label: "Dashboard",     icon: LayoutDashboard },
      { id: "agents",      href: "/agents",       label: "Agents",        icon: Bot },
      { id: "connect",     href: "/agents/connect", label: "Connect repo", icon: GitBranch },
      { id: "builder",     href: "/builder",      label: "Builder",       icon: Wand2 },
      { id: "marketplace", href: "/marketplace",  label: "Marketplace",   icon: Box },
      { id: "multi-agent", href: "/multi-agent",  label: "Multi-Agent",   icon: Network, badge: "beta" },
      { id: "sandbox",     href: "/sandbox",      label: "Sandbox",       icon: Server },
    ],
  },
  {
    id: "observe",
    label: "Observe",
    items: [
      { id: "traces",   href: "/traces",   label: "Trace Explorer", icon: Layers },
      { id: "replay",   href: "/replay",   label: "Replay",         icon: PlayCircle },
      {
        id: "observability",
        href: "/observability",
        label: "Observability",
        icon: Activity,
        children: [
          { id: "obs-apm",         href: "/observability/apm",         label: "APM Tracing",     icon: GitBranch },
          { id: "obs-cohorts",     href: "/observability/cohorts",     label: "Columnar Engine", icon: Database },
          { id: "obs-decisions",   href: "/observability/decisions",   label: "Decisions",       icon: Compass },
          { id: "obs-eval",        href: "/observability/eval",        label: "Eval",            icon: BarChart3 },
          { id: "obs-memory",      href: "/observability/memory",      label: "Memory",          icon: Brain },
          { id: "obs-query",       href: "/observability/query",       label: "Query",           icon: Sparkles },
          { id: "obs-retrieval",   href: "/observability/retrieval",   label: "Retrieval",       icon: Network },
          { id: "obs-time-travel", href: "/observability/time-travel", label: "Time-Travel",     icon: History },
        ],
      },
      { id: "tools",     href: "/tools",     label: "Tools",     icon: Wrench },
      { id: "insights",  href: "/insights",  label: "Insights",  icon: Brain },
      { id: "inspector", href: "/inspector", label: "Inspector", icon: Compass },
      { id: "incidents", href: "/incidents", label: "Incidents", icon: AlertOctagon },
      { id: "alerts",    href: "/alerts",    label: "Alerts",    icon: Bell },
      { id: "llmops",    href: "/llmops",    label: "LLMOps",    icon: Cog },
      { id: "analytics", href: "/analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    id: "optimize",
    label: "Optimize",
    items: [
      {
        id: "optimization",
        href: "/optimization",
        label: "Cost",
        icon: Sparkles,
        children: [
          { id: "opt-outcomes", href: "/optimization/outcomes", label: "Outcomes",   icon: Compass },
          { id: "opt-predict",  href: "/optimization/predict",  label: "Predictive", icon: BarChart3 },
        ],
      },
      { id: "studio",     href: "/studio",     label: "Custom Metrics", icon: FlaskConical },
      { id: "guardrails", href: "/guardrails", label: "Guardrails",     icon: Shield },
    ],
  },
  {
    id: "automate",
    label: "Automate",
    items: [
      { id: "autonomous",     href: "/autonomous",     label: "Autonomous",     icon: Wand2 },
      { id: "closed-loop",    href: "/closed-loop",    label: "Closed-Loop",    icon: Inbox },
      { id: "pr-suggestions", href: "/pr-suggestions", label: "PR Suggestions", icon: GitPullRequestArrow, badge: "new" },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    items: [
      { id: "settings", href: "/settings",           label: "Settings", icon: Settings },
      { id: "users",    href: "/users",              label: "Members",  icon: Users },
      { id: "billing",  href: "/billing",            label: "Billing",  icon: CreditCard },
      { id: "docs",     href: "/docs",               label: "Docs",     icon: FileText },
      { id: "profile",  href: "/profile",            label: "Profile",  icon: User },
    ],
  },
];

/** All item ids in the default sidebar (flat). Used for validation. */
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
