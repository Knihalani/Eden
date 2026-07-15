"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Clock,
  FileCode,
  Filter,
  GitPullRequestArrow,
  History,
  RefreshCw,
  Search,
  TrendingUp,
} from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { improvePlansApi, type ImprovementPlan, type ImprovementPlanKind, type ImprovementPlanStatus } from "@/lib/api";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/ui/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ImprovePlanStatusBadge } from "@/components/ui/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { PlanKindBadge } from "@/components/improve/plan-kind-badge";
import { errorFromCaught } from "@/lib/safe-error-message";

const PAGE_SIZE = 50;

function relativeTime(iso: string): string {
  try {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return iso;
  }
}

function SkeletonCard() {
  return (
    <Card className="border-[var(--border-default)] bg-[var(--bg-base)]">
      <div className="p-5 space-y-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </Card>
  );
}

function PlanCard({ plan, onClick }: { plan: ImprovementPlan; onClick: () => void }) {
  const files = plan.files_changed ?? [];
  return (
    <Card
      onClick={onClick}
      className="cursor-pointer border-[var(--border-default)] bg-[var(--bg-base)] hover:border-[var(--border-default)] transition-colors"
    >
      <div className="p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <PlanKindBadge kind={plan.plan_kind} />
          <ImprovePlanStatusBadge status={plan.status} />
        </div>
        <div>
          <h3 className="text-sm font-medium text-[var(--text-primary)] line-clamp-2">
            {plan.title || "Untitled improvement plan"}
          </h3>
          {plan.summary && (
            <p className="text-xs text-[var(--text-muted)] mt-1 line-clamp-2">{plan.summary}</p>
          )}
        </div>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {files.slice(0, 3).map((f) => (
              <Badge
                key={f.path}
                variant="outline"
                className="text-[10px] bg-[var(--bg-base)] text-[var(--text-muted)] border-[var(--border-default)]"
              >
                <FileCode className="h-2.5 w-2.5 mr-0.5" />
                {f.path.split("/").pop()}
              </Badge>
            ))}
            {files.length > 3 && (
              <Badge
                variant="outline"
                className="text-[10px] bg-[var(--bg-base)] text-[var(--text-muted)] border-[var(--border-default)]"
              >
                +{files.length - 3} more
              </Badge>
            )}
          </div>
        )}
        <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
          <div className="flex items-center gap-3">
            {plan.estimated_blast_radius && (
              <span className="flex items-center gap-1">
                <TrendingUp className="h-3 w-3" />
                {plan.estimated_blast_radius} blast
              </span>
            )}
            {plan.pr_number != null && (
              <span className="flex items-center gap-1 text-[var(--accent)]">
                <GitPullRequestArrow className="h-3 w-3" />#{plan.pr_number}
              </span>
            )}
          </div>
          <span>{relativeTime(plan.created_at)}</span>
        </div>
      </div>
    </Card>
  );
}

export default function ImprovementPlansPage() {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const [plans, setPlans] = useState<ImprovementPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<ImprovementPlanStatus | "all">("all");
  const [kindFilter, setKindFilter] = useState<ImprovementPlanKind | "all">("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const loadPlans = useCallback(
    async (fetchLimit: number, markLoadingMore = false) => {
      if (!currentOrg) return;
      if (markLoadingMore) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams();
        if (statusFilter !== "all") params.set("status", statusFilter);
        if (kindFilter !== "all") params.set("plan_kind", kindFilter);
        if (search) params.set("search", search);
        params.set("limit", String(fetchLimit));
        const data = await improvePlansApi.listPlans(currentOrg.id, params.toString());
        setPlans(data.data.plans ?? []);
      } catch (err) {
        setError(errorFromCaught(err, "Failed to load plans"));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [currentOrg, statusFilter, kindFilter, search],
  );

  useEffect(() => {
    setLimit(PAGE_SIZE);
    void loadPlans(PAGE_SIZE);
  }, [loadPlans]);

  const handleLoadMore = useCallback(() => {
    const next = limit + PAGE_SIZE;
    setLimit(next);
    void loadPlans(next, true);
  }, [limit, loadPlans]);

  const canLoadMore = !loading && !error && plans.length === limit;

  const stats = useMemo(
    () => ({
      pending: plans.filter((p) =>
        ["draft", "pending_review"].includes(p.status),
      ).length,
      prOpened: plans.filter((p) => p.status === "pr_opened").length,
      merged: plans.filter(
        (p) =>
          p.status === "merged" &&
          Date.now() - new Date(p.created_at).getTime() < 30 * 86400 * 1000,
      ).length,
      codePatches: plans.filter((p) => p.plan_kind === "code_patch").length,
    }),
    [plans],
  );

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="Improvement plans"
        description="Select an organization to review agent-proposed improvements."
      />
    );
  }

  return (
    <PageContent size="wide">
      <PageHeader
        title="Improvement plans"
        subtitle="Unified inbox for code patches, prompt updates, and nudges from the recurring improvement agent"
        icon={GitPullRequestArrow}
        actions={
          <Button
            variant="outline"
            onClick={() => void loadPlans(limit)}
            disabled={loading}
            size="sm"
          >
            <RefreshCw className={cn("h-4 w-4 mr-1", loading && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="Pending review" value={stats.pending} icon={Clock} />
        <StatCard title="PRs open" value={stats.prOpened} icon={GitPullRequestArrow} />
        <StatCard title="Merged (30d)" value={stats.merged} icon={History} />
        <StatCard title="Code patches" value={stats.codePatches} icon={FileCode} />
      </div>

      <Card className="border-[var(--border-default)] bg-[var(--bg-base)]">
        <div className="p-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <Search className="h-4 w-4 text-[var(--text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title or summary…"
              aria-label="Search improvement plans"
              className="w-full bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-1.5 text-sm text-[var(--text-primary)]"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-[var(--text-muted)]" />
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value as ImprovementPlanKind | "all")}
              aria-label="Filter by plan kind"
              className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-1.5 text-sm text-[var(--text-primary)]"
            >
              <option value="all">All kinds</option>
              <option value="code_patch">Code patch</option>
              <option value="prompt_update">Prompt update</option>
              <option value="nudge_promote">Nudge promote</option>
              <option value="guardrail_tune">Guardrail tune</option>
              <option value="config_change">Config change</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as ImprovementPlanStatus | "all")}
              aria-label="Filter by status"
              className="bg-[var(--bg-base)] border border-[var(--border-default)] rounded px-3 py-1.5 text-sm text-[var(--text-primary)]"
            >
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="pending_review">Pending review</option>
              <option value="pr_opened">PR opened</option>
              <option value="merged">Merged</option>
              <option value="rejected">Rejected</option>
              <option value="snoozed">Snoozed</option>
            </select>
          </div>
        </div>
      </Card>

      {error && (
        <Card className="border-[var(--error)]/20 bg-[var(--error)]/5">
          <div
            role="alert"
            className="p-3 text-sm text-[var(--error)] flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              {error}
            </span>
            <button
              type="button"
              onClick={() => void loadPlans(limit)}
              disabled={loading}
              className="text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        </Card>
      )}

      {loading && plans.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="grid grid-cols-1 md:grid-cols-2 gap-3"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : plans.length === 0 ? (
        <EmptyState
          title="No improvement plans yet"
          description="The recurring improvement agent sweeps production signals and lands ranked plans here. Configure the schedule under Settings → Autonomous."
          icon={History}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              onClick={() => router.push(`/improve/plans/${plan.id}`)}
            />
          ))}
        </div>
      )}

      {canLoadMore && (
        <div className="flex justify-center pt-2">
          <Button
            variant="outline"
            size="default"
            onClick={handleLoadMore}
            loading={loadingMore}
            disabled={loadingMore}
          >
            Load more plans
          </Button>
        </div>
      )}
    </PageContent>
  );
}
