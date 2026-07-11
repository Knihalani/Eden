"use client";

import { useEffect, useState } from "react";
import {
  AlertOctagon,
  Brain,
  Calculator,
  CheckCircle2,
  ClipboardList,
  Database,
  Gauge,
  GitBranch,
  GraduationCap,
  Layers,
  ListChecks,
  Microscope,
  Network,
  Settings2,
  ShieldCheck,
  Sliders,
  Sparkles,
  TrendingUp,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  apmApi,
  autonomousApi,
  closedLoopApi,
  costApi,
  evalApi,
  experimentsApi,
  governanceApi,
  guardrailsApi,
  intelligenceAgentsApi,
  memoryApi,
  metricStudioApi,
  outcomesApi,
  predictiveApi,
  rcaApi,
  replayApi,
  retrievalApi,
  toolsApi,
  userApi,
} from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { StatCard } from "@/components/ui/stat-card";

interface CardSpec {
  key: string;
  title: string;
  href: string;
  icon: LucideIcon;
  iconClassName: string;
  load: (orgId: string) => Promise<unknown>;
  /**
   * Reduce the API response to a single numeric/string value for display.
   * Return `null` to render the empty state.
   */
  pick: (raw: unknown) => string | number | null;
  /** Optional secondary line of text (e.g. "of 12 enabled"). */
  pickSubtitle?: (raw: unknown) => string | null;
  /** Trend chip. */
  trendIsGood?: "up" | "down";
  trend?: "up" | "down" | null;
  trendValue?: string;
  emptyText?: string;
}

export function IntelligenceGrid() {
  const { currentOrg } = useOrg();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentOrg) {
      setLoading(false);
      return;
    }
    const cacheKey = `eden:intel-grid:${currentOrg.id}`;
    try {
      const cached = window.sessionStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { at: number; values: Record<string, unknown> };
        if (Date.now() - parsed.at < 120_000) {
          setValues(parsed.values);
          setLoading(false);
          return;
        }
      }
    } catch {
      // ignore corrupt cache
    }

    let cancelled = false;
    setLoading(true);
    const orgId = currentOrg.id;
    (async () => {
      const loaded: Record<string, unknown> = {};
      const queue = [...CARDS];
      const concurrency = 4;
      const staggerMs = 75;

      async function worker() {
        while (queue.length > 0 && !cancelled) {
          const card = queue.shift();
          if (!card) break;
          await new Promise((r) => setTimeout(r, staggerMs));
          try {
            loaded[card.key] = await card.load(orgId);
          } catch {
            loaded[card.key] = null;
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (cancelled) return;
      setValues(loaded);
      setLoading(false);
      try {
        window.sessionStorage.setItem(
          cacheKey,
          JSON.stringify({ at: Date.now(), values: loaded }),
        );
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  return (
    <section>
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <div>
          <h2 className="text-base sm:text-lg font-semibold text-[var(--text-primary)] tracking-tight">
            Intelligence at a glance
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Top-of-funnel signal for every observability category.
          </p>
        </div>
      </div>
      <div className="space-y-4 sm:space-y-6">
        {CATEGORIES.map((category) => (
          <CategoryRow
            key={category.key}
            category={category}
            values={values}
            loading={loading}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Renders one category as: 1 hero card + N micro cards in a grid.
 * ui-audit 2026-07-06 M2: breaks the 17-uniform-tile template by
 * varying tile size per intent — hero for actionable counts,
 * micro for secondary counts.
 */
function CategoryRow({
  category,
  values,
  loading,
}: {
  category: Category;
  values: Record<string, unknown>;
  loading: boolean;
}) {
  const cardMap = new Map(CARDS.map((c) => [c.key, c]));
  return (
    <div>
      {/* Category eyebrow — terminal micro-label pattern */}
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[var(--accent)]">
          {category.label}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] truncate">
          {category.description}
        </span>
      </div>

      {/* Hero tile: 2/3 width on desktop, full width on mobile */}
      {(() => {
        const hero = cardMap.get(category.heroKey);
        if (!hero) return null;
        const raw = values[hero.key];
        const ready = !loading;
        const value = ready ? hero.pick(raw) : null;
        const subtitle = ready ? hero.pickSubtitle?.(raw) ?? null : null;
        const isEmpty = ready && (value === null || value === undefined);
        return (
          <div className="mb-3">
            <StatCard
              title={hero.title}
              value={value ?? "—"}
              subtitle={subtitle ?? undefined}
              icon={hero.icon}
              iconClassName={hero.iconClassName}
              loading={loading}
              href={hero.href}
              empty={isEmpty}
              emptyText={hero.emptyText}
              trend={ready ? hero.trend ?? null : null}
              trendValue={hero.trendValue}
              trendIsGood={hero.trendIsGood}
              // ui-audit M2: hero gets visual weight via an opaque
              // elevated surface + thicker border + top accent line.
              // No gradients (anti-pattern) and no glow rings
              // (anti-pattern). The StatCard base already renders a
              // border + bg; we override to --bg-secondary (one
              // step deeper than the default --bg-primary) and add
              // a 2px top accent that reads as "featured" without
              // looking decorative.
              className="bg-[var(--bg-secondary)] border-[var(--border-strong)] border-t-2 border-t-[var(--accent)] shadow-md"
            />
          </div>
        );
      })()}

      {/* Micro tiles: 2-3 col grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
        {category.microKeys.map((key) => {
          const card = cardMap.get(key);
          if (!card) return null;
          const raw = values[key];
          const ready = !loading;
          const value = ready ? card.pick(raw) : null;
          const subtitle = ready ? card.pickSubtitle?.(raw) ?? null : null;
          const isEmpty = ready && (value === null || value === undefined);
          return (
            <StatCard
              key={key}
              title={card.title}
              value={value ?? "—"}
              subtitle={subtitle ?? undefined}
              icon={card.icon}
              iconClassName={card.iconClassName}
              loading={loading}
              href={card.href}
              empty={isEmpty}
              emptyText={card.emptyText}
              trend={ready ? card.trend ?? null : null}
              trendValue={card.trendValue}
              trendIsGood={card.trendIsGood}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── card specs ────────────────────────────────────────────────────────
//
// The list is intentionally long: it surfaces the *count* or *score* of
// the headline metric for every observability category so that any zero
// or anomaly shows up on the dashboard before the user has to drill in.

const CARDS: CardSpec[] = [
  // Cat 2 — Incidents & RCA
  {
    key: "incidents",
    title: "Active Incidents",
    href: "/incidents",
    icon: AlertOctagon,
    iconClassName: "bg-[var(--error-bg)] text-[var(--error)]",
    load: (orgId) => rcaApi.listIncidents(orgId),
    pick: (raw) => {
      const data = raw as { incidents?: unknown[] } | null;
      return data?.incidents?.length ?? 0;
    },
    pickSubtitle: () => "clusters detected",
    emptyText: "No incidents detected",
  },
  // Cat 8 — Cost Intelligence (efficiency score)
  {
    key: "cost_efficiency",
    title: "Cost Efficiency",
    href: "/optimization",
    icon: Gauge,
    iconClassName: "bg-[var(--accent-light)] text-[var(--accent)]",
    load: (orgId) => costApi.efficiency(orgId, { days: 7 }),
    pick: (raw) => {
      const data = raw as { efficiency_score?: number } | null;
      if (!data || typeof data.efficiency_score !== "number") return null;
      return Math.round(data.efficiency_score * 100);
    },
    pickSubtitle: () => "score · last 7 days",
    emptyText: "Route calls to populate efficiency data",
  },
  // Cat 11 — Outcomes / ROI
  {
    key: "roi",
    title: "Avg ROI",
    href: "/optimization/outcomes",
    icon: TrendingUp,
    iconClassName: "bg-[var(--accent-light)] text-[var(--accent)]",
    load: (orgId) => outcomesApi.listDepartments(orgId),
    pick: (raw) => {
      const data = raw as { departments?: Array<{ roi: number }> } | null;
      const depts = data?.departments ?? [];
      if (depts.length === 0) return null;
      const avg = depts.reduce((sum, d) => sum + (d.roi ?? 0), 0) / depts.length;
      return `${avg.toFixed(2)}×`;
    },
    pickSubtitle: (raw) => {
      const data = raw as { departments?: unknown[] } | null;
      return `${data?.departments?.length ?? 0} departments`;
    },
    emptyText: "Track outcomes to compute ROI",
  },
  // Cat 13 — Predictive / Drift
  {
    key: "drift",
    title: "Drift Score",
    href: "/optimization/predict",
    icon: Brain,
    iconClassName: "bg-[var(--warning-bg)] text-[var(--warning-strong)]",
    load: (orgId) => predictiveApi.drift(orgId),
    pick: (raw) => {
      const data = raw as { drift_score?: number; drift_detected?: boolean } | null;
      if (!data || typeof data.drift_score !== "number") return null;
      return Number(data.drift_score.toFixed(3));
    },
    pickSubtitle: (raw) => {
      const data = raw as { drift_detected?: boolean; severity?: string } | null;
      if (!data) return null;
      return data.drift_detected
        ? `drift detected · ${data.severity ?? "—"}`
        : "no drift detected";
    },
    emptyText: "No drift signal yet",
  },
  // Cat 13 — Predictive / Risk
  {
    key: "risk",
    title: "Risk Score",
    href: "/optimization/predict",
    icon: Microscope,
    iconClassName: "bg-[var(--primary-light)] text-[var(--primary)]",
    load: (orgId) => predictiveApi.risk(orgId),
    pick: (raw) => {
      const data = raw as { risk_score?: number } | null;
      if (!data || typeof data.risk_score !== "number") return null;
      return Math.round(data.risk_score);
    },
    pickSubtitle: () => "composite · live",
    emptyText: "No risk data yet",
  },
  // Cat 15 — Guardrails
  {
    key: "guardrails",
    title: "Guardrail Policies",
    href: "/guardrails",
    icon: ShieldCheck,
    iconClassName: "bg-[var(--accent-light)] text-[var(--accent)]",
    load: (orgId) => guardrailsApi.listPolicies(orgId),
    pick: (raw) => {
      const data = raw as { policies?: Array<{ enabled: boolean }> } | null;
      return data?.policies?.length ?? 0;
    },
    pickSubtitle: (raw) => {
      const data = raw as { policies?: Array<{ enabled: boolean }> } | null;
      const enabled = (data?.policies ?? []).filter((p) => p.enabled).length;
      return `${enabled} enabled`;
    },
    emptyText: "No guardrail policies",
  },
  // Cat 9 — User Intelligence (cohort dashboard)
  {
    key: "user_satisfaction",
    title: "User Satisfaction",
    href: "/users",
    icon: Sparkles,
    iconClassName: "bg-[var(--accent-light)] text-[var(--accent)]",
    load: (orgId) => userApi.getCohortDashboard(orgId),
    pick: (raw) => {
      const data = raw as { cohorts?: Array<{ satisfaction: number }> } | null;
      const cohorts = data?.cohorts ?? [];
      if (cohorts.length === 0) return null;
      const avg = cohorts.reduce((s, c) => s + (c.satisfaction ?? 0), 0) / cohorts.length;
      return `${(avg * 100).toFixed(0)}%`;
    },
    pickSubtitle: (raw) => {
      const data = raw as { cohorts?: unknown[] } | null;
      return `${data?.cohorts?.length ?? 0} cohorts tracked`;
    },
    emptyText: "No user signal yet",
  },
  // Cat 21 — Custom Metric Studio
  {
    key: "custom_metrics",
    title: "Custom Metrics",
    href: "/studio",
    icon: Calculator,
    iconClassName: "bg-[var(--primary-light)] text-[var(--primary)]",
    load: (orgId) => metricStudioApi.listMetrics(orgId),
    pick: (raw) => {
      const data = raw as { metrics?: unknown[] } | null;
      return data?.metrics?.length ?? 0;
    },
    pickSubtitle: () => "defined rubrics",
    emptyText: "Define a custom metric",
  },
  // Cat 22 — APM Depth (sampling kept/dropped ratio)
  {
    key: "apm_sampling",
    title: "APM Keep Ratio",
    href: "/apm",
    icon: Sliders,
    iconClassName: "bg-[var(--accent-light)] text-[var(--accent)]",
    load: (orgId) => apmApi.samplingStats(orgId),
    pick: (raw) => {
      const data = raw as { kept?: number; total_evaluated?: number; dropped?: number } | null;
      if (!data || !data.total_evaluated) return null;
      const kept = data.kept ?? 0;
      const pct = (kept / data.total_evaluated) * 100;
      return `${pct.toFixed(0)}%`;
    },
    pickSubtitle: (raw) => {
      const data = raw as { kept?: number; dropped?: number } | null;
      return `${data?.kept ?? 0} kept · ${data?.dropped ?? 0} dropped`;
    },
    emptyText: "No sampling data yet",
  },
  // Cat 10 — Governance (compliance packs + security findings)
  {
    key: "governance",
    title: "Compliance Packs",
    href: "/settings",
    icon: CheckCircle2,
    iconClassName: "bg-[var(--accent-light)] text-[var(--accent)]",
    load: (orgId) => governanceApi.dashboard(orgId),
    pick: (raw) => {
      const data = raw as { compliance_packs?: number } | null;
      return data?.compliance_packs ?? 0;
    },
    pickSubtitle: (raw) => {
      const data = raw as { security_findings?: number; approvals_pending?: number } | null;
      if (!data) return null;
      return `${data.security_findings ?? 0} findings · ${data.approvals_pending ?? 0} approvals`;
    },
    emptyText: "No compliance packs generated",
  },
  // Cat 4 — Retrieval Intelligence (knowledge gaps)
  {
    key: "retrieval_gaps",
    title: "Knowledge Gaps",
    href: "/observability/retrieval",
    icon: Database,
    iconClassName: "bg-[var(--warning-bg)] text-[var(--warning-strong)]",
    load: (orgId) => retrievalApi.gaps(orgId),
    pick: (raw) => {
      const data = raw as { gaps?: unknown[] } | null;
      return data?.gaps?.length ?? 0;
    },
    pickSubtitle: () => "queries without coverage",
    emptyText: "No retrieval gaps detected",
  },
  // Cat 5 — Memory Intelligence (Reweaver suggestions)
  {
    key: "memory_reaver",
    title: "Reweaver Suggestions",
    href: "/observability/memory",
    icon: GitBranch,
    iconClassName: "bg-[var(--primary-light)] text-[var(--primary)]",
    load: (orgId) => memoryApi.reweaverSuggest(orgId),
    pick: (raw) => {
      const data = raw as { suggestions?: unknown[] } | null;
      return data?.suggestions?.length ?? 0;
    },
    pickSubtitle: () => "merge / archive / demote",
    emptyText: "No memory actions suggested",
  },
  // Cat 3 — Eval (judge version count)
  {
    key: "eval_versions",
    title: "Eval Versions",
    href: "/observability/eval",
    icon: GraduationCap,
    iconClassName: "bg-[var(--accent-light)] text-[var(--accent)]",
    load: (orgId) => evalApi.listVersions(orgId),
    pick: (raw) => {
      const data = raw as { versions?: unknown[] } | null;
      return data?.versions?.length ?? 0;
    },
    pickSubtitle: () => "tagged judges",
    emptyText: "No tagged eval versions",
  },
  // Cat 14 — Autonomous (recommendations)
  {
    key: "recommendations",
    title: "Recommendations",
    href: "/autonomous",
    icon: ListChecks,
    iconClassName: "bg-[var(--primary-light)] text-[var(--primary)]",
    load: (orgId) => autonomousApi.recommendations(orgId),
    pick: (raw) => {
      const data = raw as { recommendations?: unknown[] } | null;
      return data?.recommendations?.length ?? 0;
    },
    pickSubtitle: () => "autonomous suggestions",
    emptyText: "No recommendations yet",
  },
  // Cat 12 — Experiments (active traffic splits)
  {
    key: "experiments",
    title: "Active Experiments",
    href: "/experiments",
    icon: Layers,
    iconClassName: "bg-[var(--accent-light)] text-[var(--accent)]",
    load: (orgId) => experimentsApi.listTrafficSplits(orgId),
    pick: (raw) => {
      const data = raw as { splits?: unknown[] } | null;
      return data?.splits?.length ?? 0;
    },
    pickSubtitle: () => "traffic splits",
    emptyText: "No active experiments",
  },
  // Cat 7 — Tool Intelligence
  {
    key: "tools",
    title: "Tracked Tools",
    href: "/tools",
    icon: Wrench,
    iconClassName: "bg-[var(--primary-light)] text-[var(--primary)]",
    load: (orgId) => toolsApi.attribution(orgId, { days: 7 }),
    pick: (raw) => {
      const data = raw as { tools?: unknown[] } | null;
      return data?.tools?.length ?? 0;
    },
    pickSubtitle: (raw) => {
      const data = raw as { tools?: Array<{ success_rate: number }> } | null;
      const tools = data?.tools ?? [];
      if (tools.length === 0) return null;
      const avg = tools.reduce((s, t) => s + (t.success_rate ?? 0), 0) / tools.length;
      return `${(avg * 100).toFixed(0)}% avg success`;
    },
    emptyText: "No tool telemetry yet",
  },
  // Cat 17 — Closed-Loop (pending actions)
  {
    key: "closed_loop",
    title: "Pending Actions",
    href: "/closed-loop",
    icon: ClipboardList,
    iconClassName: "bg-[var(--warning-bg)] text-[var(--warning-strong)]",
    load: (orgId) => closedLoopApi.dashboard(orgId),
    pick: (raw) => {
      const data = raw as { data?: { by_status?: Record<string, number> } } | null;
      return data?.data?.by_status?.pending_approval ?? 0;
    },
    pickSubtitle: (raw) => {
      const data = raw as { data?: { by_status?: Record<string, number> } } | null;
      return `${data?.data?.by_status?.applied ?? 0} applied`;
    },
    emptyText: "Inbox zero",
  },
  // Cat 6 — Agent Intelligence (fleet / performance)
  {
    key: "agents_fleet",
    title: "Agent Fleet",
    href: "/agents",
    icon: Network,
    iconClassName: "bg-[var(--primary-light)] text-[var(--primary)]",
    load: (orgId) => intelligenceAgentsApi.performance(orgId),
    pick: (raw) => {
      const data = raw as { agents?: unknown[] } | null;
      return data?.agents?.length ?? 0;
    },
    pickSubtitle: () => "agents tracked",
    emptyText: "No agents registered",
  },
  // Cat 16 — Replay & Decision (sessions)
  {
    key: "replay_sessions",
    title: "Replay Sessions",
    href: "/replay",
    icon: Settings2,
    iconClassName: "bg-[var(--primary-light)] text-[var(--primary)]",
    load: (orgId) => replayApi.listSessions(orgId),
    pick: (raw) => {
      const data = raw as { sessions?: unknown[] } | null;
      return data?.sessions?.length ?? 0;
    },
    pickSubtitle: () => "decision replays",
    emptyText: "No replay sessions",
  },
];

// ── Categories — ui-audit 2026-07-06 M2 ─────────────────────────────
//
// Group CARDS into intent-based categories. Each category has ONE
// hero tile (the most actionable signal) and several micro tiles
// (secondary counts). The grid renders one row per category with
// a hero + micro sub-grid, breaking the 17-uniform-tile template
// that the audit flagged as templated.
//
// To re-categorize: change the `category` field on a CardSpec.
// Cards not listed in any category render in a fallback row at
// the end (defensive — every card should belong somewhere).

type Category = {
  key: string;
  label: string;
  description: string;
  heroKey: string;
  microKeys: string[];
};

const CATEGORIES: Category[] = [
  {
    key: "operate",
    label: "Operate",
    description: "Live system health — incidents, risk, drift",
    heroKey: "incidents",
    microKeys: ["risk", "drift", "replay_sessions"],
  },
  {
    key: "quality",
    label: "Quality",
    description: "Outcomes + ROI + agent performance",
    heroKey: "roi",
    microKeys: ["user_satisfaction", "agents_fleet", "tools", "eval_versions"],
  },
  {
    key: "knowledge",
    label: "Knowledge",
    description: "Retrieval coverage + memory hygiene",
    heroKey: "retrieval_gaps",
    microKeys: ["memory_reaver", "custom_metrics"],
  },
  {
    key: "optimize",
    label: "Optimize",
    description: "Cost, APM sampling, experiments",
    heroKey: "cost_efficiency",
    microKeys: ["apm_sampling", "experiments", "guardrails", "governance", "closed_loop", "recommendations"],
  },
];
