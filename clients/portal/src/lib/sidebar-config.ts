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
 *
 * Icon rule (portal polish): Sparkles / Brain / Wand2 appear at most once
 * each product-wide. Collision pairs use eden-nav-icons glyphs.
 */

import type { ComponentType } from "react";
import {
  LayoutDashboard,
  Wand2,
  Box,
  Network,
  Layers,
  PlayCircle,
  Activity,
  GitBranch,
  Database,
  BarChart3,
  History,
  Wrench,
  Cog,
  FlaskConical,
  Inbox,
  ListTodo,
  Settings,
  Users,
  CreditCard,
  FileText,
  User,
  FileSpreadsheet,
  Tag,
  Bug,
  ShieldAlert,
  Radio,
  type LucideIcon,
} from "lucide-react";
import {
  TraceIcon,
  EvalIcon,
  CostIcon,
  IncidentIcon,
  AgentIcon,
  PatchIcon,
  GuardrailIcon,
  AlertNavIcon,
  InsightsIcon,
  MemoryIcon,
  QueryIcon,
  InspectorIcon,
  DecisionsIcon,
} from "@/components/icons/eden-nav-icons";
import { DOCS_URL } from "@/lib/constants";

/** Lucide or Eden semantic glyph — both accept className. */
export type SidebarIcon = LucideIcon | ComponentType<{ className?: string }>;

export interface SidebarItem {
  /** Stable id for customisation (pin / hide / reorder). */
  id: string;
  /** Path the item links to. */
  href: string;
  /** Display label. */
  label: string;
  /** Icon component (Lucide or eden-nav-icons). */
  icon: SidebarIcon;
  /** Short one-line description shown in the sidebar tooltip so the
   *  user knows "what is this page for" without clicking. Plain
   *  language, no jargon — e.g. "See what every AI call is doing"
   *  rather than "Distributed tracing explorer". */
  description?: string;
  /** Optional badge text shown next to the label (e.g. "new", "beta"). */
  badge?: string;
  /** Nested items (rendered as a sub-group under the parent). */
  children?: SidebarItem[];
  /** Tag the item as "advanced" — it hides behind the
   *  "Advanced" toggle in the sidebar (June 2026 cleanup).
   *  Defaults to undefined = "core" (always visible). */
  category?: "core" | "advanced";
}

export interface SidebarGroup {
  id: "build" | "observe" | "optimize" | "automate" | "workspace";
  label: string;
  items: SidebarItem[];
}

// "Build" surfaces things you construct: dashboard, agents, connect,
// prompts. Dataset / labeling tools (curate labelled eval sets) live
// here because they're authoring actions — not analysis.
//
// "Observe" is the answer to "what happened" — traces, replay,
// observability hub + advanced surfaces, alerts, incidents, the
// derived analysis (insights, tools, inspector).
//
// "Optimize" is the answer to "make it cheaper / better" — cost
// surfaces, custom metrics, guardrails.
//
// "Automate" is the answer to "ship the fix" — autonomous loops, PR
// suggestions, closed-loop improvements.
//
// "Workspace" collects settings / members / billing / docs / profile
// so the IA reads top-to-bottom as: build → observe → optimize →
// automate → workspace, and the user only needs to scan 5 group labels.
//
// Observe defaults: core = Traces, Agent Issues, Fleet, Observability hub,
// Incidents, Alerts. Replay / Insights / Tools / Inspector / User Intel /
// LLMOps / Analytics sit behind Advanced (≥40% hidden by default).
export const DEFAULT_SIDEBAR: SidebarGroup[] = [
  {
    id: "build",
    label: "Build",
    items: [
      { id: "dashboard",   href: "/dashboard",      label: "Dashboard",     icon: LayoutDashboard },
      { id: "agents",      href: "/agents",         label: "Agents",        icon: AgentIcon , description: "Manage AI agents: connect repos, view runs, edit prompts, and configure tools."},
      { id: "datasets",    href: "/datasets",       label: "Datasets",      icon: FileSpreadsheet , category: "advanced", description: "Curate labelled evaluation datasets used to score and improve agents."},
      { id: "labeling",    href: "/labeling",       label: "Labeling",      icon: Tag , category: "advanced", description: "Label traces and events to build ground truth for evals and fine-tunes."},
      { id: "connect",     href: "/agents/connect", label: "Connect repo",  icon: GitBranch , category: "advanced", description: "Link a GitHub repo so Eden can read your code and open integration PRs."},
      { id: "prompts",     href: "/prompts",        label: "Prompts",       icon: FileText, category: "advanced", description: "Version and manage prompt templates with a full change history."},
    ],
  },
  {
    id: "observe",
    label: "Observe",
    items: [
      // Renamed 2026-07-06: "Trace Explorer" → "Traces" to match the
      // /traces URL and the user's mental model (one trace = one row).
      // "Trace Explorer" implied a debugger that was different from the
      // top-level /observability hub, which was confusing.
      { id: "traces",   href: "/traces",   label: "Traces",  icon: TraceIcon },
      { id: "issues",   href: "/issues",   label: "Agent Issues", icon: ShieldAlert, description: "Grouped agent failures (stumbles) with auto-triage, heal, and verify lifecycle."},
      { id: "fleet",    href: "/fleet",    label: "Fleet",   icon: Network, description: "Fleet health, delegation graph, and multi-agent blast-radius scoring."},
      { id: "replay",   href: "/replay",   label: "Replay",  icon: PlayCircle , category: "advanced", description: "Step through a recorded session to see exactly what the agent saw and did."},
      {
        id: "observability",
        href: "/observability",
        label: "Observability hub",
        icon: Activity,
        children: [
          { id: "obs-apm",         href: "/observability/apm",         label: "APM Tracing",     icon: GitBranch, category: "advanced" , description: "Application-performance tracing across services and AI calls."},
          { id: "obs-mcp",         href: "/observability/mcp",         label: "MCP SRE",         icon: Radio, description: "MCP server auth failures and toolchain health."},
          { id: "obs-cohorts",     href: "/observability/cohorts",     label: "Columnar Engine", icon: Database, category: "advanced" , description: "Run fast columnar analytics over spans, traces, and decisions."},
          { id: "obs-decisions",   href: "/observability/decisions",   label: "Decisions",       icon: DecisionsIcon, category: "advanced" , description: "Inspect what an agent decided and why, with policy and prompt context."},
          { id: "obs-eval",        href: "/observability/eval",        label: "Eval",            icon: EvalIcon, category: "advanced" , description: "Score traces against evals to measure quality and regressions."},
          { id: "obs-synthetic",   href: "/synthetic",                 label: "Synthetic Q/A",   icon: FlaskConical, category: "advanced", description: "Generate synthetic Q/A pairs to expand your eval datasets."},
          { id: "obs-debugger",    href: "/debugger",                  label: "Debugger",        icon: Bug, description: "Inspect agent checkpoints and re-run from an earlier step."},
          { id: "obs-memory",      href: "/observability/memory",      label: "Memory",          icon: MemoryIcon, category: "advanced" , description: "Inspect the memory store an agent reads from and writes to."},
          { id: "obs-query",       href: "/observability/query",       label: "Query",           icon: QueryIcon, category: "advanced" , description: "Ad-hoc query the trace corpus with natural language or SQL."},
          { id: "obs-retrieval",   href: "/observability/retrieval",   label: "Retrieval",       icon: Network, category: "advanced" , description: "Debug retrieval-augmented generation: chunks, scores, and grounding."},
          { id: "obs-time-travel", href: "/observability/time-travel", label: "Time-Travel",     icon: History, category: "advanced" , description: "Reconstruct the state of an agent at any point in a past run."},
        ],
      },
      { id: "tools",     href: "/tools",     label: "Tools",     icon: Wrench, category: "advanced" , description: "See which tools your agents call most, compare success rates, and get recommendations."},
      { id: "insights",  href: "/insights",  label: "Insights",  icon: InsightsIcon , category: "advanced", description: "AI-generated summaries of trends, anomalies, and what to look at next."},
      // LP-13: GET /signals fail-opens (empty list / 503) when nl_signals
      // missing — re-enabled after backend contract stabilization (F48).
      { id: "signals",   href: "/signals",   label: "Signals",   icon: Radio, category: "advanced", description: "Compile behavioural signals from traces into reusable detectors." },
      { id: "user-intelligence", href: "/users", label: "User Intelligence", icon: Users, category: "advanced", description: "Session aggregation, satisfaction scoring, and behavioural cohorts."},
      { id: "inspector", href: "/inspector", label: "Inspector", icon: InspectorIcon, category: "advanced" , description: "Deep-dive into a single trace to debug behaviour, token usage, and tool I/O."},
      { id: "incidents", href: "/incidents", label: "Incidents", icon: IncidentIcon , description: "Systemic RCA clusters — patterns across many failures. For individual grouped failures, see Agent Issues."},
      { id: "alerts",    href: "/alerts",    label: "Alerts",    icon: AlertNavIcon , description: "Configure notifications when traces, costs, or quality cross a threshold."},
      { id: "llmops",    href: "/llmops",    label: "LLMOps",    icon: Cog, category: "advanced" , description: "Operational controls for LLM providers, rate limits, and fallbacks."},
      { id: "analytics", href: "/analytics", label: "Analytics", icon: BarChart3, category: "advanced" , description: "Cross-cutting analytics: usage, cost, latency, and quality over time."},
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
        icon: CostIcon,
        children: [
          { id: "opt-outcomes",   href: "/optimization/outcomes",      label: "Outcomes",     icon: Box , category: "advanced", description: "Business-outcome attribution from agent runs to downstream results."},
          { id: "opt-predict",    href: "/optimization/predict",       label: "Predictive",   icon: BarChart3 , category: "advanced", description: "Judge-score quality forecast and drift detection."},
          { id: "opt-advisor",    href: "/optimization/model-advisor", label: "Model Advisor", icon: Layers, badge: "new" , category: "advanced", description: "Get model-routing suggestions to cut cost without hurting quality (new)."},
        ],
      },
      { id: "studio",     href: "/studio",     label: "Custom Metrics", icon: FlaskConical, category: "advanced" , description: "Define custom metrics and dimensions for traces and runs."},
      { id: "guardrails", href: "/guardrails", label: "Guardrails",     icon: GuardrailIcon , description: "Block unsafe prompts, PII leaks, and policy violations before they ship."},
      { id: "redteam",    href: "/redteam",    label: "Red team",       icon: ShieldAlert, category: "advanced", description: "Run adversarial probes against your prompts and review findings."},
    ],
  },
  {
    id: "automate",
    label: "Automate",
    items: [
      { id: "improve",        href: "/improve",        label: "Improve",        icon: ListTodo, description: "Unified action queue — triage, patches, nudges, and promotions from detected issues."},
      { id: "autonomous",     href: "/autonomous",     label: "Autonomous",     icon: Wand2, category: "advanced", description: "Run investigations and remediations on demand."},
      { id: "closed-loop",    href: "/closed-loop",    label: "Closed-Loop",    icon: Inbox, category: "advanced" , description: "Closed-loop improvements — events flow from detection back to deploy."},
      { id: "pr-suggestions", href: "/pr-suggestions", label: "PR Suggestions", icon: PatchIcon, badge: "new", category: "advanced" , description: "Auto-generated PRs that fix issues Eden finds in your repo (new)."},
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { id: "settings", href: "/settings", label: "Settings", icon: Settings },
      { id: "members",  href: "/settings?tab=members", label: "Members",  icon: Users , description: "Invite teammates and manage org members and roles."},
      { id: "billing",  href: "/billing",  label: "Billing",  icon: CreditCard , description: "Plan, invoices, payment method, and usage-based charges."},
      { id: "docs",     href: DOCS_URL, label: "Docs", icon: FileText , description: "API reference, guides, and code examples for the Eden platform."},
      { id: "profile",  href: "/profile",  label: "Profile",  icon: User , category: "advanced", description: "Your personal account settings, sessions, and API keys."},
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
