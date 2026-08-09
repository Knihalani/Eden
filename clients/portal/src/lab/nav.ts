/**
 * Product nav — one leaf, one route, one active state.
 * Grouped sections for scanability (Observe / Evaluate / Improve / Assist / Workspace).
 */

export type NavIcon =
  | "home"
  | "agents"
  | "traces"
  | "issues"
  | "signals"
  | "topics"
  | "evals"
  | "playgrounds"
  | "improve"
  | "cost"
  | "gateway"
  | "agent"
  | "debugger"
  | "compare"
  | "prompts"
  | "guardrails"
  | "labeling"
  | "settings";

export type NavItem = {
  id: string;
  label: string;
  href: string;
  icon: NavIcon;
};

export type NavSection = {
  id: string;
  label: string | null;
  items: NavItem[];
};

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "observe",
    label: null,
    items: [
      { id: "home", label: "Home", href: "/home", icon: "home" },
      { id: "agents", label: "Agents", href: "/agents", icon: "agents" },
      { id: "traces", label: "Traces", href: "/traces", icon: "traces" },
      { id: "issues", label: "Issues", href: "/issues", icon: "issues" },
      { id: "signals", label: "Detectors", href: "/signals", icon: "signals" },
      { id: "topics", label: "Topics", href: "/topics", icon: "topics" },
    ],
  },
  {
    id: "evaluate",
    label: "Evaluate",
    items: [
      { id: "evals", label: "Evals", href: "/evals", icon: "evals" },
      {
        id: "playgrounds",
        label: "Playgrounds",
        href: "/playgrounds",
        icon: "playgrounds",
      },
      { id: "prompts", label: "Prompts", href: "/prompts", icon: "prompts" },
      { id: "compare", label: "Live A/B", href: "/compare", icon: "compare" },
      {
        id: "labeling",
        label: "Labeling",
        href: "/labeling",
        icon: "labeling",
      },
    ],
  },
  {
    id: "improve",
    label: "Improve",
    items: [
      { id: "improve", label: "Improve", href: "/improve", icon: "improve" },
      { id: "guardrails", label: "Guardrails", href: "/guardrails", icon: "guardrails" },
      { id: "cost", label: "Cost", href: "/cost", icon: "cost" },
      { id: "gateway", label: "Gateway", href: "/gateway", icon: "gateway" },
    ],
  },
  {
    id: "assist",
    label: "Assist",
    items: [
      { id: "agent", label: "Assistant", href: "/agent", icon: "agent" },
      { id: "debugger", label: "Debugger", href: "/debugger", icon: "debugger" },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
    ],
  },
];

/** Flat list for callers that still iterate PRIMARY_NAV. */
export const PRIMARY_NAV: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/** Exact leaf active — never light up two siblings at once. */
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Milestone under review — IA + soft-land (Phase A). */
export const CURRENT_GATE = "G15a — Nav IA + soft-land";
