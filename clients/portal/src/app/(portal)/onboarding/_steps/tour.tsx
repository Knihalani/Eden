/**
 * TourStep — visual tour of the major portal components.
 *
 * Step 4 of the activation path. Replaces the previous "Install SDK"
 * step (which is now an optional flow reachable from the chat or
 * from Settings → Agent). This step shows the user what's in the
 * portal, what each section does, and how to use it, with a
 * visual card per component.
 *
 * The cards are clickable links to each section's primary route —
 * clicking doesn't navigate away from the wizard; the user can
 * tour-and-return. The wizard's "Next" button advances to /done.
 *
 * The chat card is intentionally highlighted last because the
 * agent is the highest-leverage tool for getting unstuck ("just
 * ask Eden" is the catch-all onboarding line for everything else).
 */
"use client";

import Link from "next/link";
import {
  Activity,
  AlertOctagon,
  Bot,
  Gauge,
  GitBranch,
  History,
  Layers,
  LineChart,
  Search,
  Settings,
  Sparkles,
  Terminal,
  Wand2,
} from "lucide-react";
import type { WizardContext } from "@/components/ui/wizard";

interface TourCard {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  hotkey?: string;
  highlight?: boolean;
}

const CARDS: TourCard[] = [
  {
    href: "/dashboard",
    icon: Gauge,
    title: "Dashboard",
    body: "Live signals from your agents: traces per minute, success rate, and recent alerts. Lands here by default after sign-in.",
  },
  {
    href: "/traces",
    icon: Search,
    title: "Trace Explorer",
    body: "Search every trace in the system. Filter by agent, model, status, duration, or free-text. Click any row for the full timeline + tree.",
    hotkey: "/",
  },
  {
    href: "/observability",
    icon: LineChart,
    title: "Observability",
    body: "Run a judge, replay a trace, or compare environments side-by-side. The cat-1 + cat-2 surfaces live here.",
  },
  {
    href: "/alerts",
    icon: AlertOctagon,
    title: "Alerts",
    body: "Active alerts + the rules that fired them. Click any rule to see why it triggered and which traces are affected.",
  },
  {
    href: "/incidents",
    icon: History,
    title: "Incidents",
    body: "Open RCA clusters. Each one is a group of similar failures with a likely cause + suggested fix.",
  },
  {
    href: "/agents",
    icon: Bot,
    title: "Agents",
    body: "Your agent fleet. Push a new agent (eden agent-push), run a sim, or upload an existing one (eden agent-upload).",
  },
  {
    href: "/agents/connect",
    icon: GitBranch,
    title: "Connect a repo",
    body: "Link a GitHub repo via the Eden GitHub App. Eden opens an SDK-integration PR; once merged, traces flow automatically.",
  },
  {
    href: "/optimization",
    icon: Sparkles,
    title: "Optimization",
    body: "Token + cost overview, cache hit rate, and projections. Drill into any model to see spend per request.",
  },
  {
    href: "/settings",
    icon: Settings,
    title: "Settings",
    body: "Org, members, billing, SSO, API keys, and the SDK install snippet (also reachable from the chat).",
  },
  {
    href: "/onboarding/install",
    icon: Terminal,
    title: "Install the SDK",
    body: "Optional — only if you want to instrument code by hand. If you connected a GitHub repo above, Eden handled this for you.",
  },
  {
    href: "/",
    icon: Wand2,
    title: "Chat with Eden (AI Insights)",
    body: "The fastest way to get unstuck. Ask anything about your data: traces, costs, recent failures. The agent reads from the same DB you're looking at — answers are cited, never hallucinated.",
    highlight: true,
    hotkey: "⌘K",
  },
];

export function TourStep(_ctx: WizardContext) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">A quick tour of Eden</h1>
        <p className="mt-2 text-[var(--text-secondary)]">
          Every section below is a clickable jump. The most useful one to
          remember is the <span className="text-[var(--text-primary)] font-medium">chat</span> at the
          bottom right — Eden can read, query, and explain anything in
          your workspace.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              key={card.href + card.title}
              href={card.href}
              className={[
                "group relative flex flex-col gap-2 rounded-lg border p-4 transition-colors",
                card.highlight
                  ? "border-[var(--accent)]/40 bg-[var(--accent-faint)] hover:border-[var(--accent)]"
                  : "border-[var(--border-default)] bg-[var(--bg-secondary)] hover:border-[var(--accent)]/40 hover:bg-[var(--bg-tertiary)]/40",
              ].join(" ")}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Icon
                    className={[
                      "h-4 w-4",
                      card.highlight
                        ? "text-[var(--accent)]"
                        : "text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]",
                    ].join(" ")}
                  />
                  <h3 className="text-sm font-medium text-[var(--text-primary)]">
                    {card.title}
                  </h3>
                </div>
                {card.hotkey && (
                  <kbd className="rounded border border-[var(--border-default)] bg-[var(--bg-base)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-muted)]">
                    {card.hotkey}
                  </kbd>
                )}
              </div>
              <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                {card.body}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
