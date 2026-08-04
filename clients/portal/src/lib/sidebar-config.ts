/**
 * Prefs/editor sidebar config — keep leaf ids/hrefs aligned with `@/lab/nav`.
 * Live shell SoT remains `@/lab/nav`; this file drives pin-hide prefs only.
 * Labels resolve from the English fallbacks below (labelKey is a stable id).
 */

import type { ComponentType } from "react";
import {
  Home,
  Bot,
  GitBranch,
  AlertTriangle,
  Activity,
  FlaskConical,
  Sparkles,
  Shield,
  CircleDollarSign,
  Network,
  MessageSquare,
  Bug,
  GitCompare,
  FileText,
  Play,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type SidebarIcon = LucideIcon | ComponentType<{ className?: string }>;

export interface SidebarItem {
  id: string;
  href: string;
  /** Stable label id (historically `nav.leaves.*`). */
  labelKey: string;
  icon: SidebarIcon;
  descriptionKey?: string;
  category?: "core" | "advanced";
  children?: SidebarItem[];
}

export interface SidebarGroup {
  id: "observe" | "evaluate" | "improve" | "assist" | "workspace";
  /** Stable label id (historically `nav.groups.*`). */
  labelKey: string;
  items: SidebarItem[];
}

/** Live product leaf ids — mirrors PRIMARY_NAV in `@/lab/nav`. */
export const CORE_NAV_LEAF_IDS = [
  "home",
  "agents",
  "traces",
  "issues",
  "signals",
  "evals",
  "playgrounds",
  "prompts",
  "compare",
  "improve",
  "guardrails",
  "cost",
  "gateway",
  "agent",
  "debugger",
  "settings",
] as const;

export type CoreNavLeafId = (typeof CORE_NAV_LEAF_IDS)[number];

/** @deprecated Prefer CORE_NAV_LEAF_IDS — kept for stub-era smoke tests. */
export const STUB_CORE_SURFACE_IDS = CORE_NAV_LEAF_IDS;

export type StubCoreSurfaceId = CoreNavLeafId;

export const CORE_NAV_ITEM_COUNT = CORE_NAV_LEAF_IDS.length;

/** No core leaves remain stubbed after Phase 7. Later surfaces use redirects, not /_stub. */
export const STUB_SURFACE_IDS = [] as readonly CoreNavLeafId[];

/** Mobile bottom nav — exactly 5 hubs (mirrors mobile-nav BOTTOM_IDS). */
export const MOBILE_BOTTOM_NAV = [
  {
    id: "home" as const,
    href: "/home",
    labelKey: "nav.leaves.home",
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

/** More sheet — core leaves not on bottom nav. */
export const MOBILE_MORE_NAV = [
  { id: "agents" as const, href: "/agents", labelKey: "nav.leaves.agents" },
  { id: "signals" as const, href: "/signals", labelKey: "nav.leaves.signals" },
  {
    id: "playgrounds" as const,
    href: "/playgrounds",
    labelKey: "nav.leaves.playgrounds",
  },
  { id: "prompts" as const, href: "/prompts", labelKey: "nav.leaves.prompts" },
  { id: "compare" as const, href: "/compare", labelKey: "nav.leaves.compare" },
  {
    id: "guardrails" as const,
    href: "/guardrails",
    labelKey: "nav.leaves.guardrails",
  },
  { id: "cost" as const, href: "/cost", labelKey: "nav.leaves.cost" },
  { id: "gateway" as const, href: "/gateway", labelKey: "nav.leaves.gateway" },
  { id: "agent" as const, href: "/agent", labelKey: "nav.leaves.agent" },
  {
    id: "debugger" as const,
    href: "/debugger",
    labelKey: "nav.leaves.debugger",
  },
  {
    id: "settings" as const,
    href: "/settings",
    labelKey: "nav.leaves.settings",
  },
] as const;

export const DEFAULT_SIDEBAR: SidebarGroup[] = [
  {
    id: "observe",
    labelKey: "nav.groups.observe",
    items: [
      {
        id: "home",
        href: "/home",
        labelKey: "nav.leaves.home",
        icon: Home,
        category: "core",
      },
      {
        id: "agents",
        href: "/agents",
        labelKey: "nav.leaves.agents",
        icon: Bot,
        category: "core",
      },
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
        icon: AlertTriangle,
        category: "core",
      },
      {
        id: "signals",
        href: "/signals",
        labelKey: "nav.leaves.signals",
        icon: Activity,
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
      {
        id: "playgrounds",
        href: "/playgrounds",
        labelKey: "nav.leaves.playgrounds",
        icon: Play,
        category: "core",
      },
      {
        id: "prompts",
        href: "/prompts",
        labelKey: "nav.leaves.prompts",
        icon: FileText,
        category: "core",
      },
      {
        id: "compare",
        href: "/compare",
        labelKey: "nav.leaves.compare",
        icon: GitCompare,
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
        icon: Shield,
        category: "core",
      },
      {
        id: "cost",
        href: "/cost",
        labelKey: "nav.leaves.cost",
        icon: CircleDollarSign,
        category: "core",
      },
      {
        id: "gateway",
        href: "/gateway",
        labelKey: "nav.leaves.gateway",
        icon: Network,
        category: "core",
      },
    ],
  },
  {
    id: "assist",
    labelKey: "nav.groups.assist",
    items: [
      {
        id: "agent",
        href: "/agent",
        labelKey: "nav.leaves.agent",
        icon: MessageSquare,
        category: "core",
      },
      {
        id: "debugger",
        href: "/debugger",
        labelKey: "nav.leaves.debugger",
        icon: Bug,
        category: "core",
      },
    ],
  },
  {
    id: "workspace",
    labelKey: "nav.groups.workspace",
    items: [
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
  home: "Home",
  agents: "Agents",
  traces: "Traces",
  issues: "Issues",
  signals: "Detectors",
  evals: "Evals",
  playgrounds: "Playgrounds",
  prompts: "Prompts",
  compare: "Live A/B",
  improve: "Improve",
  guardrails: "Guardrails",
  cost: "Cost",
  gateway: "Gateway",
  agent: "Assistant",
  debugger: "Debugger",
  settings: "Settings",
};

export const SIDEBAR_GROUP_LABELS: Record<SidebarGroup["id"], string> = {
  observe: "Observe",
  evaluate: "Evaluate",
  improve: "Improve",
  assist: "Assist",
  workspace: "Workspace",
};
