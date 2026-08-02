/**
 * Rebuild IA sidebar — 12 core leaves.
 * Phase 7: all must-ship leaves live (agent, audit, settings); Later surfaces stay redirected.
 * Labels resolve via next-intl (labelKey).
 */

import type { ComponentType } from "react";
import {
  LayoutDashboard,
  Bot,
  GitBranch,
  ShieldAlert,
  Bell,
  FlaskConical,
  Sparkles,
  ShieldCheck,
  CircleDollarSign,
  MessageSquare,
  ScrollText,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type SidebarIcon = LucideIcon | ComponentType<{ className?: string }>;

export interface SidebarItem {
  id: string;
  href: string;
  /** next-intl key under `nav.leaves.*` */
  labelKey: string;
  icon: SidebarIcon;
  descriptionKey?: string;
  category?: "core" | "advanced";
  children?: SidebarItem[];
}

export interface SidebarGroup {
  id: "home" | "agents" | "observe" | "evaluate" | "improve" | "workspace";
  /** next-intl key under `nav.groups.*` */
  labelKey: string;
  items: SidebarItem[];
}

/** Exactly the 12 core leaf ids (IA §1.1). */
export const CORE_NAV_LEAF_IDS = [
  "dashboard",
  "agents",
  "traces",
  "issues",
  "alerts",
  "evals",
  "improve",
  "guardrails",
  "cost",
  "agent",
  "audit",
  "settings",
] as const;

export type CoreNavLeafId = (typeof CORE_NAV_LEAF_IDS)[number];

/** @deprecated Prefer CORE_NAV_LEAF_IDS — kept for stub-era smoke tests. */
export const STUB_CORE_SURFACE_IDS = CORE_NAV_LEAF_IDS;

export type StubCoreSurfaceId = CoreNavLeafId;

export const CORE_NAV_ITEM_COUNT = CORE_NAV_LEAF_IDS.length;

/** No core leaves remain stubbed after Phase 7. Later surfaces use redirects, not /_stub. */
export const STUB_SURFACE_IDS = [] as readonly CoreNavLeafId[];

/** Mobile bottom nav — exactly 5 hubs (PHASES §1.5). */
export const MOBILE_BOTTOM_NAV = [
  {
    id: "dashboard" as const,
    href: "/home",
    labelKey: "nav.leaves.dashboard",
  },
  {
    id: "traces" as const,
    href: "/traces",
    labelKey: "nav.leaves.traces",
  },
  {
    id: "issues" as const,
    href: "/issues",
    labelKey: "nav.leaves.issues",
  },
  {
    id: "evals" as const,
    href: "/evals",
    labelKey: "nav.leaves.evals",
  },
  {
    id: "improve" as const,
    href: "/improve",
    labelKey: "nav.leaves.improve",
  },
] as const;

/** More sheet — core leaves not on bottom nav + secondary (debugger, prompts, analytics). */
export const MOBILE_MORE_NAV = [
  { id: "agents" as const, href: "/agents", labelKey: "nav.leaves.agents" },
  { id: "alerts" as const, href: "/alerts", labelKey: "nav.leaves.alerts" },
  { id: "cost" as const, href: "/cost", labelKey: "nav.leaves.cost" },
  {
    id: "guardrails" as const,
    href: "/guardrails",
    labelKey: "nav.leaves.guardrails",
  },
  { id: "agent" as const, href: "/agent", labelKey: "nav.leaves.agent" },
  {
    id: "debugger" as const,
    href: "/debugger",
    labelKey: "nav.leaves.debugger",
  },
  { id: "prompts" as const, href: "/prompts", labelKey: "nav.leaves.prompts" },
  {
    id: "sessions" as const,
    href: "/sessions",
    labelKey: "nav.leaves.sessions",
  },
  {
    id: "settings" as const,
    href: "/settings",
    labelKey: "nav.leaves.settings",
  },
] as const;

export const DEFAULT_SIDEBAR: SidebarGroup[] = [
  {
    id: "home",
    labelKey: "nav.groups.home",
    items: [
      {
        id: "dashboard",
        href: "/home",
        labelKey: "nav.leaves.dashboard",
        icon: LayoutDashboard,
        category: "core",
      },
    ],
  },
  {
    id: "agents",
    labelKey: "nav.groups.agents",
    items: [
      {
        id: "agents",
        href: "/agents",
        labelKey: "nav.leaves.agents",
        icon: Bot,
        category: "core",
      },
    ],
  },
  {
    id: "observe",
    labelKey: "nav.groups.observe",
    items: [
      {
        id: "traces",
        href: "/traces",
        labelKey: "nav.leaves.traces",
        icon: GitBranch,
        category: "core",
      },
      {
        id: "issues",
        href: "/issues",
        labelKey: "nav.leaves.issues",
        icon: ShieldAlert,
        category: "core",
      },
      {
        id: "alerts",
        href: "/alerts",
        labelKey: "nav.leaves.alerts",
        icon: Bell,
        category: "core",
      },
    ],
  },
  {
    id: "evaluate",
    labelKey: "nav.groups.evaluate",
    items: [
      {
        id: "evals",
        href: "/evals",
        labelKey: "nav.leaves.evals",
        icon: FlaskConical,
        category: "core",
      },
    ],
  },
  {
    id: "improve",
    labelKey: "nav.groups.improve",
    items: [
      {
        id: "improve",
        href: "/improve",
        labelKey: "nav.leaves.improve",
        icon: Sparkles,
        category: "core",
      },
      {
        id: "guardrails",
        href: "/guardrails",
        labelKey: "nav.leaves.guardrails",
        icon: ShieldCheck,
        category: "core",
      },
      {
        id: "cost",
        href: "/cost",
        labelKey: "nav.leaves.cost",
        icon: CircleDollarSign,
        category: "core",
      },
    ],
  },
  {
    id: "workspace",
    labelKey: "nav.groups.workspace",
    items: [
      {
        id: "agent",
        href: "/agent",
        labelKey: "nav.leaves.agent",
        icon: MessageSquare,
        category: "core",
      },
      {
        id: "audit",
        href: "/settings?mode=audit",
        labelKey: "nav.leaves.audit",
        icon: ScrollText,
        category: "core",
      },
      {
        id: "settings",
        href: "/settings",
        labelKey: "nav.leaves.settings",
        icon: Settings,
        category: "core",
      },
    ],
  },
];

export function getCoreNavLeaves(): SidebarItem[] {
  return DEFAULT_SIDEBAR.flatMap((g) => g.items).filter(
    (i) => i.category !== "advanced",
  );
}

/** Flat list of all sidebar item ids (settings prefs / pin-hide editor). */
export const ALL_ITEM_IDS: readonly string[] = DEFAULT_SIDEBAR.flatMap((g) =>
  g.items.flatMap((item) => [
    item.id,
    ...(item.children?.map((c) => c.id) ?? []),
  ]),
);

/**
 * English fallback labels for settings sidebar editor (i18n on chrome elsewhere).
 * Align vocabulary with lab/nav where leaves overlap (Home, Detectors, Assistant).
 * Live shell SoT remains `@/lab/nav` — this config is prefs/editor only.
 */
export const SIDEBAR_ITEM_LABELS: Record<string, string> = {
  dashboard: "Home",
  agents: "Agents",
  traces: "Traces",
  issues: "Issues",
  alerts: "Detectors",
  evals: "Evals",
  improve: "Improve",
  guardrails: "Guardrails",
  cost: "Cost",
  agent: "Assistant",
  audit: "Audit",
  settings: "Settings",
};

export const SIDEBAR_GROUP_LABELS: Record<SidebarGroup["id"], string> = {
  home: "Home",
  agents: "Agents",
  observe: "Observe",
  evaluate: "Evaluate",
  improve: "Improve",
  workspace: "Workspace",
};
