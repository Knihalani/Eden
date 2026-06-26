"use client";

/**
 * /observability — landing page (June 2026 UI overhaul).
 *
 * Hub for every "Observe"-group surface. The page is data-light on
 * purpose: it shows live status (alert count, last 24h trace count,
 * active agents) so the user knows whether anything needs attention,
 * then routes them to the 8 dedicated sub-routes via cards. The
 * extracted tab components (TraceTreeTab, TimelineTab, HeatmapTab,
 * CompareTab) live in _components/ and are reused by future sub-routes.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Activity,
  BarChart3,
  Brain,
  Compass,
  Database,
  GitBranch,
  History,
  Loader2,
  Network,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { api, agentsApi } from "@/lib/api";
import { cn } from "@/lib/utils";

interface SubPage {
  href: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SUBPAGES: SubPage[] = [
  // APM Tracing moved to OTel Collector (June 2026); the /observability/apm
  // route renders a static notice rather than a live surface, so it is
  // intentionally absent from the hub cards.
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

interface HubStats {
  traces24h: number;
  unreadAlerts: number;
  activeAgents: number;
  loading: boolean;
}

export default function ObservabilityLanding() {
  const { currentOrg } = useOrg();
  const [stats, setStats] = useState<HubStats>({
    traces24h: 0,
    unreadAlerts: 0,
    activeAgents: 0,
    loading: true,
  });

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    setStats((s) => ({ ...s, loading: true }));
    Promise.allSettled([
      api.listObservabilityTraces(currentOrg.id, { limit: 1, days: 1 }).catch(() => null),
      api.listAlerts(currentOrg.id, { limit: 1 }).catch(() => null),
      agentsApiSafe(currentOrg.id),
    ]).then(([tracesRes, alertsRes, agentsRes]) => {
      if (cancelled) return;
      setStats({
        traces24h: tracesRes.status === "fulfilled" ? tracesRes.value?.total ?? 0 : 0,
        unreadAlerts:
          alertsRes.status === "fulfilled"
            ? alertsRes.value?.unread_count ?? alertsRes.value?.alerts?.length ?? 0
            : 0,
        activeAgents: agentsRes.status === "fulfilled" ? agentsRes.value : 0,
        loading: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  if (!currentOrg) return <NoOrgState feature="Observability" />;

  return (
    <>
      <PageHeader
        eyebrow="Observe"
        title="Observability"
        subtitle="Inspect, evaluate, and replay every interaction in your agent stack"
        icon={Activity}
      />

      <div className="px-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full space-y-6 page-enter">
        {/* Live hub stats — gives the user a single-glance status before
            they dive into a sub-page. Each tile is a real route so the
            user can drill down. ponytail: 4 stat blocks per row on
            desktop, single column on mobile, no skeleton shimmer. */}
        <section>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <HubTile
              href="/traces"
              icon={Activity}
              label="Traces · last 24h"
              value={stats.loading ? null : stats.traces24h}
              tone="accent"
            />
            <HubTile
              href="/alerts"
              icon={Sparkles}
              label="Open alerts"
              value={stats.loading ? null : stats.unreadAlerts}
              tone={stats.unreadAlerts > 0 ? "warning" : "neutral"}
            />
            <HubTile
              href="/agents"
              icon={Brain}
              label="Active agents"
              value={stats.loading ? null : stats.activeAgents}
              tone="neutral"
            />
            <HubTile
              href="/observability/eval"
              icon={BarChart3}
              label="Eval quality"
              value="View →"
              tone="neutral"
              isLink
            />
          </div>
        </section>

        {/* Sub-page cards */}
        <section>
          <header className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              Drill into
            </h2>
            <span className="text-xs text-[var(--text-muted)]">
              {SUBPAGES.length} surfaces
            </span>
          </header>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {SUBPAGES.map((s) => (
              <Link key={s.href} href={s.href} className="group">
                <Card
                  variant="interactive"
                  className={cn(
                    "h-full p-5 transition-all duration-150",
                    "hover:border-[var(--accent)]/50",
                  )}
                >
                  <div className="flex items-start justify-between mb-3">
                    <s.icon className="h-6 w-6 text-[var(--accent)]" />
                    <ArrowRight className="h-4 w-4 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
                  </div>
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
        </section>

        <p className="pt-2 text-center text-xs text-[var(--text-muted)]">
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

/** ponytail: minimal local helper — fetches active agents count without
 *  re-implementing the agents list call. The agentsApi helper exposes
 *  list() with a total field for pagination; we only need the total. */
async function agentsApiSafe(orgId: string): Promise<number> {
  try {
    const res = await agentsApi.list(orgId, { limit: 1 });
    return res.agents?.length ?? 0;
  } catch {
    return 0;
  }
}

function HubTile({
  href,
  icon: Icon,
  label,
  value,
  tone,
  isLink,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string | null;
  tone: "accent" | "warning" | "neutral";
  isLink?: boolean;
}) {
  const toneClass =
    tone === "accent"
      ? "text-[var(--accent)] bg-[var(--accent-light)]"
      : tone === "warning"
        ? "text-[var(--warning)] bg-[var(--warning-bg)]"
        : "text-[var(--text-secondary)] bg-[var(--bg-tertiary)]";
  return (
    <Link
      href={href}
      className={cn(
        "block bg-[var(--bg-primary)] rounded-xl p-4 border border-[var(--border-default)]",
        "hover:border-[var(--accent)]/40 hover:shadow-sm transition-all",
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <div className={cn("p-1.5 rounded-md", toneClass)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "text-2xl font-bold tracking-tight",
          isLink ? "text-sm font-medium text-[var(--accent)]" : "text-[var(--text-primary)]",
        )}
      >
        {value === null ? (
          <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
        ) : (
          value
        )}
      </p>
    </Link>
  );
}