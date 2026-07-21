"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
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
import { usePermissions } from "@/hooks/use-permissions";
import { useOrgQuery } from "@/hooks/use-api-query";
import {
  improvePlansApi,
  type ImprovementPlan,
  type ImprovementPlanKind,
  type ImprovementPlanStatus,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ImprovePlanStatusBadge } from "@/components/ui/status-badge";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { PlanKindBadge } from "@/components/improve/plan-kind-badge";
import { ImproveFeatureDisabledState } from "@/components/improve/feature-disabled-state";
import { errorFromCaught } from "@/lib/safe-error-message";
import { isImprovementAgentDisabled } from "@/lib/improve-feature";

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

function PlanRow({ plan, onClick }: { plan: ImprovementPlan; onClick: () => void }) {
  const files = plan.files_changed ?? [];
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full flex-col gap-space-1 border-b border-[var(--border-subtle)] px-space-1 py-space-3 text-left transition-colors hover:bg-[var(--bg-secondary)]/50 last:border-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-space-2">
        <h3 className="text-sm font-medium leading-snug text-[var(--text-primary)] line-clamp-2">
          {plan.title || "Untitled improvement plan"}
        </h3>
        <span className="shrink-0 text-xs text-[var(--text-muted)]">
          {relativeTime(plan.created_at)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-space-2">
        <ImprovePlanStatusBadge status={plan.status} />
        <PlanKindBadge kind={plan.plan_kind} />
        {plan.estimated_blast_radius ? (
          <span className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <TrendingUp className="h-3 w-3" />
            {plan.estimated_blast_radius} blast
          </span>
        ) : null}
        {plan.pr_number != null ? (
          <span className="inline-flex items-center gap-1 text-xs text-[var(--accent)]">
            <GitPullRequestArrow className="h-3 w-3" />#{plan.pr_number}
          </span>
        ) : null}
      </div>
      {plan.summary ? (
        <p className="text-xs text-[var(--text-muted)] line-clamp-1">{plan.summary}</p>
      ) : null}
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {files.slice(0, 3).map((f) => (
            <Badge
              key={f.path}
              variant="outline"
              className="text-xs bg-transparent text-[var(--text-muted)] border-[var(--border-subtle)]"
            >
              <FileCode className="h-2.5 w-2.5 mr-0.5" />
              {f.path.split("/").pop()}
            </Badge>
          ))}
          {files.length > 3 ? (
            <span className="text-xs text-[var(--text-muted)]">+{files.length - 3} more</span>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

export default function ImprovementPlansPage() {
  const router = useRouter();
  const { currentOrg, authError } = useOrg();
  const { hasPermission } = usePermissions();
  const canManageKeys = hasPermission("settings:edit");
  const orgId = currentOrg?.id ?? null;
  const [statusFilter, setStatusFilter] = useState<ImprovementPlanStatus | "all">("all");
  const [kindFilter, setKindFilter] = useState<ImprovementPlanKind | "all">("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);

  const filters = useMemo(
    () => ({
      status: statusFilter,
      kind: kindFilter,
      search,
      limit,
    }),
    [statusFilter, kindFilter, search, limit],
  );

  const plansQuery = useOrgQuery(
    queryKeys.improve.plans(orgId, filters),
    orgId,
    async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (kindFilter !== "all") params.set("plan_kind", kindFilter);
      if (search) params.set("search", search);
      params.set("limit", String(limit));
      const data = await improvePlansApi.listPlans(orgId!, params.toString());
      return data.data.plans ?? [];
    },
  );

  const plans = plansQuery.data ?? [];
  const loading = plansQuery.isLoading || plansQuery.isFetching;
  const featureDisabled =
    !!plansQuery.error && isImprovementAgentDisabled(plansQuery.error);
  const error =
    plansQuery.error && !featureDisabled
      ? errorFromCaught(plansQuery.error, "Failed to load plans")
      : "";

  const handleLoadMore = () => {
    setLimit((prev) => prev + PAGE_SIZE);
  };

  const canLoadMore = !loading && !error && !featureDisabled && plans.length === limit;

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
    }),
    [plans],
  );

  if (!currentOrg && !authError) {
    return (
      <NoOrgState
        feature="Improvement plans"
        description="Select an organization to review agent-proposed improvements."
      />
    );
  }
  if (!currentOrg) return null;

  return (
    <PageContent size="wide">
      <div className="contents" data-wave3-improve-plans="completed">
      <PageHeader
        title="Improvement plans"
        subtitle="Code patches, prompt updates, and nudges from the improvement agent"
        icon={GitPullRequestArrow}
        actions={
          <Button
            variant="outline"
            onClick={() => void plansQuery.refetch()}
            disabled={loading}
            size="sm"
            className="min-h-11"
          >
            <RefreshCw className={cn("h-4 w-4 mr-1", loading && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      {featureDisabled ? (
        <ImproveFeatureDisabledState />
      ) : (
        <>
          {error ? (
            <ErrorState
              title="Could not load plans"
              message={error}
              action={
                <Button
                  onClick={() => void plansQuery.refetch()}
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  loading={loading}
                >
                  Try again
                </Button>
              }
            />
          ) : null}

          {!error && !(plansQuery.isLoading && plans.length === 0) ? (
            <>
              <div
                className="flex flex-wrap items-center gap-x-space-4 gap-y-1 text-xs text-[var(--text-muted)]"
                data-testid="improve-plans-kpi"
              >
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  Pending{" "}
                  <strong className="text-[var(--text-primary)] tabular-nums">
                    {stats.pending}
                  </strong>
                </span>
                <span className="inline-flex items-center gap-1">
                  <GitPullRequestArrow className="h-3.5 w-3.5" />
                  PRs open{" "}
                  <strong className="text-[var(--text-primary)] tabular-nums">
                    {stats.prOpened}
                  </strong>
                </span>
                <span className="inline-flex items-center gap-1">
                  <History className="h-3.5 w-3.5" />
                  Merged 30d{" "}
                  <strong className="text-[var(--text-primary)] tabular-nums">
                    {stats.merged}
                  </strong>
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-space-3 border-b border-[var(--border-subtle)] py-space-3">
                <div className="flex items-center gap-space-2 flex-1 min-w-[200px]">
                  <Search className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <input
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setLimit(PAGE_SIZE);
                    }}
                    placeholder="Search by title or summary…"
                    aria-label="Search improvement plans"
                    className="min-h-11 w-full rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 py-space-2 text-sm text-[var(--text-primary)]"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-space-2">
                  <Filter className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <select
                    value={kindFilter}
                    onChange={(e) => {
                      setKindFilter(e.target.value as ImprovementPlanKind | "all");
                      setLimit(PAGE_SIZE);
                    }}
                    aria-label="Filter by plan kind"
                    className="min-h-11 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 py-space-2 text-sm text-[var(--text-primary)]"
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
                    onChange={(e) => {
                      setStatusFilter(e.target.value as ImprovementPlanStatus | "all");
                      setLimit(PAGE_SIZE);
                    }}
                    aria-label="Filter by status"
                    className="min-h-11 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-space-3 py-space-2 text-sm text-[var(--text-primary)]"
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
            </>
          ) : null}

          {plansQuery.isLoading && plans.length === 0 && !error ? (
            <LoadingSkeleton variant="stats" lines={6} />
          ) : !error && plans.length === 0 ? (
            <EmptyState
              title="No improvement plans yet"
              description={
                canManageKeys
                  ? "No plans yet. Needs production traces and Agent Issues first. Create an API key, install the SDK or gateway, then the improvement agent can land ranked plans here."
                  : "No plans yet. Needs production traces and Agent Issues first. Ask an admin for an API key, or open Traces once data is flowing."
              }
              icon={History}
              action={
                <Button asChild className="min-h-11">
                  <Link href="/issues">View Issues</Link>
                </Button>
              }
            />
          ) : plans.length === 0 ? null : (
            <div className="divide-y-0" data-testid="improve-plans-list">
              {plans.map((plan) => (
                <PlanRow
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
                className="min-h-11"
                onClick={handleLoadMore}
                loading={plansQuery.isFetching && plans.length > 0}
                disabled={plansQuery.isFetching}
              >
                Load more plans
              </Button>
            </div>
          )}
        </>
      )}
      </div>
    </PageContent>
  );
}
