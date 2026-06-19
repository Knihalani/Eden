"use client";

/**
 * /observability — landing page (Phase 4 of the June 2026 UI overhaul).
 *
 * The old 1182-line monolith with 6 in-page tabs (Traces/Tree/Timeline/
 * Heatmap/Compare/Scores) is replaced with a thin landing that points
 * to the 8 dedicated sub-routes. The old tabs are now reachable via
 * /traces (and the per-sub-route pages).
 *
 * The extracted tab components (TraceTreeTab, TimelineTab, HeatmapTab,
 * CompareTab) live in _components/ and can be reused by future sub-routes
 * that need them.
 */

import Link from "next/link";
import {
  Activity,
  BarChart3,
  Brain,
  Compass,
  Database,
  GitBranch,
  History,
  Network,
  Sparkles,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";

interface SubPage {
  href: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SUBPAGES: SubPage[] = [
  {
    href: "/observability/apm",
    title: "APM Tracing",
    description: "Service-level latency, error rates, and trace drilldowns",
    icon: GitBranch,
  },
  {
    href: "/observability/cohorts",
    title: "Columnar Engine",
    description: "Materialised rollups over usage_events with hourly/daily/weekly tiers",
    icon: Database,
  },
  {
    href: "/observability/decisions",
    title: "Decisions",
    description: "Trace the choice points in your agent's reasoning",
    icon: Compass,
  },
  {
    href: "/observability/eval",
    title: "Eval",
    description: "Judge scores, comparison, and quality signals",
    icon: BarChart3,
  },
  {
    href: "/observability/memory",
    title: "Memory",
    description: "Episodic + semantic memory attribution and reweaving",
    icon: Brain,
  },
  {
    href: "/observability/query",
    title: "Query",
    description: "Trace Query DSL with EQL syntax over the columnar engine",
    icon: Sparkles,
  },
  {
    href: "/observability/retrieval",
    title: "Retrieval",
    description: "Chunk attribution, gap detection, and reorder signals",
    icon: Network,
  },
  {
    href: "/observability/time-travel",
    title: "Time-Travel",
    description: "Replay traces with point-in-time state restoration",
    icon: History,
  },
];

export default function ObservabilityLanding() {
  const { currentOrg } = useOrg();
  if (!currentOrg) return <NoOrgState feature="Observability" />;

  return (
    <>
      <PageHeader
        eyebrow="Observe"
        title="Observability"
        subtitle="Inspect, evaluate, and replay every interaction in your agent stack"
        icon={Activity}
      />
      <div className="px-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {SUBPAGES.map((s) => (
            <Link key={s.href} href={s.href} className="group">
              <Card
                variant="interactive"
                className={cn("h-full p-5 transition-all duration-150")}
              >
                <s.icon className="h-6 w-6 text-[var(--accent)] mb-3" />
                <h3 className="text-base font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors">
                  {s.title}
                </h3>
                <p className="mt-1 text-sm text-[var(--text-secondary)] line-clamp-2">
                  {s.description}
                </p>
              </Card>
            </Link>
          ))}
        </div>
        <p className="mt-8 text-center text-xs text-[var(--text-muted)]">
          Looking for the trace list? It moved to{" "}
          <Link href="/traces" className="text-[var(--accent)] hover:underline">
            /traces
          </Link>
          .
        </p>
      </div>
    </>
  );
}
