export type LabSurface = {
  id: string;
  label: string;
  href: string;
  status: "not_started" | "in_progress" | "ready" | "approved";
};

/** User-facing product surfaces (shell is internal QA — not listed). */
export const LAB_SURFACES: LabSurface[] = [
  { id: "home", label: "Home", href: "/home", status: "ready" },
  { id: "agents", label: "Agents", href: "/agents", status: "ready" },
  { id: "traces", label: "Traces", href: "/traces", status: "ready" },
  { id: "issues", label: "Issues", href: "/issues", status: "ready" },
  { id: "signals", label: "Detectors", href: "/signals", status: "ready" },
  {
    id: "sessions",
    label: "Sessions",
    href: "/traces?view=sessions",
    status: "ready",
  },
  { id: "evals", label: "Evals", href: "/evals", status: "ready" },
  {
    id: "playgrounds",
    label: "Playgrounds",
    href: "/playgrounds",
    status: "ready",
  },
  { id: "compare", label: "Live A/B", href: "/compare", status: "ready" },
  { id: "improve", label: "Improve", href: "/improve", status: "ready" },
  { id: "prompts", label: "Prompts", href: "/prompts", status: "ready" },
  { id: "guardrails", label: "Guardrails", href: "/guardrails", status: "ready" },
  { id: "cost", label: "Cost", href: "/cost", status: "ready" },
  { id: "gateway", label: "Gateway", href: "/gateway", status: "ready" },
  { id: "agent", label: "Assistant", href: "/agent", status: "ready" },
  { id: "debugger", label: "Debugger", href: "/debugger", status: "ready" },
  { id: "settings", label: "Settings", href: "/settings", status: "ready" },
];

export const ROADMAP_NOTE =
  "G15a: grouped nav + soft-land. Next: empty states, density, then onboarding tour.";
