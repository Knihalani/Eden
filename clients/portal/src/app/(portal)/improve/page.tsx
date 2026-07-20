"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Check, Clock, Loader2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage, CrossLinkBar, VirtualizedList } from "@/components/portal-os";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Panel } from "@/components/ui/panel";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/components/ui/toast";
import {
  improveApi,
  improvePlansApi,
  type ImproveQueueItem,
} from "@/lib/api";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  isImprovementAgentDisabled,
  isRepoNotConnected,
  REPO_NOT_CONNECTED_MESSAGE,
} from "@/lib/improve-feature";
import { PlanKindBadge } from "@/components/improve/plan-kind-badge";
import { ImproveFeatureDisabledState } from "@/components/improve/feature-disabled-state";
import type { ImprovementPlanKind } from "@/lib/api";
import { useQueryTab } from "@/hooks/use-query-tab";
import { DOCS_QUICKSTART_URL } from "@/lib/constants";

const IMPROVE_TABS = ["queue", "plans", "history"] as const;

const PlansView = dynamic(() => import("./plans/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});
const HistoryView = dynamic(() => import("./runs/page"), {
  ssr: false,
  loading: () => <TabLoading />,
});

function TabLoading() {
  return (
    <div className="flex h-48 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
    </div>
  );
}

const COLUMNS: Array<{ id: string; label: string; hint: string }> = [
  { id: "urgent", label: "Urgent", hint: "P0 / critical issues" },
  { id: "needs_you", label: "Needs you", hint: "Approvals, credentials, merge decisions" },
  { id: "autonomous", label: "Eden fixing", hint: "Heal / canary / rollback in flight" },
  { id: "proposed", label: "Proposed", hint: "Closed-loop recommendations" },
  { id: "verify", label: "Verify", hint: "Approved patches awaiting check" },
];

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  p0: 0,
  high: 1,
  p1: 1,
  medium: 2,
  p2: 2,
  low: 3,
  p3: 3,
};

function severityRank(sev: string): number {
  return SEVERITY_RANK[sev.toLowerCase()] ?? 4;
}

function severityClass(sev: string): string {
  const s = sev.toLowerCase();
  if (s === "critical" || s === "high" || s === "p0" || s === "p1") return "text-[var(--error)]";
  if (s === "medium" || s === "p2") return "text-[var(--warning)]";
  return "text-[var(--text-muted)]";
}

function isN23PlanRef(item: ImproveQueueItem): boolean {
  return (
    item.ref.startsWith("improvement_plan:") ||
    item.item_type === "improvement_plan" ||
    item.source === "improvement_plans"
  );
}

function isLegacyProposedPatch(item: ImproveQueueItem): boolean {
  return (
    item.ref.startsWith("proposed_patch:") || item.source === "proposed_patches"
  );
}

/** Detail URL for N23 plans only — never invent /improve/plans/{legacyPatchId}. */
function planHref(item: ImproveQueueItem): string | null {
  if (item.ref.startsWith("improvement_plan:")) {
    const id = item.ref.split(":").slice(1).join(":");
    return id ? `/improve/plans/${id}` : null;
  }
  const planId = item.payload?.plan_id;
  if (
    typeof planId === "string" &&
    planId &&
    (item.source === "improvement_plans" || item.item_type === "improvement_plan")
  ) {
    return `/improve/plans/${planId}`;
  }
  // Cat 23 proposed_patches are read-only; send operators to the N23 inbox.
  if (isLegacyProposedPatch(item) || item.href?.startsWith("/pr-suggestions")) {
    return "/improve/plans";
  }
  return item.href ?? null;
}

function planKindFromItem(item: ImproveQueueItem): ImprovementPlanKind | null {
  const kind = item.payload?.plan_kind;
  if (typeof kind === "string" && kind) return kind as ImprovementPlanKind;
  if (isN23PlanRef(item)) return "code_patch";
  return null;
}

function canApproveQueueItem(item: ImproveQueueItem): boolean {
  if (item.blocked_reason) return false;
  if (item.column !== "proposed" && item.column !== "needs_you") return false;
  return (
    item.ref.startsWith("closed_loop:") || item.ref.startsWith("improvement_plan:")
  );
}

export default function ImprovePage() {
  return (
    <Suspense fallback={<TabLoading />}>
      <ImprovePageInner />
    </Suspense>
  );
}

function ImprovePageInner() {
  const { currentOrg, authError } = useOrg();
  const { hasPermission } = usePermissions();
  const canManageKeys = hasPermission("settings:edit");
  const toast = useToast();
  const orgId = currentOrg?.id ?? null;
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [tab, setTab] = useQueryTab("tab", IMPROVE_TABS, "queue");

  const queueQuery = useOrgQuery(
    queryKeys.improve.queue(orgId),
    orgId,
    async () => {
      const res = await improveApi.queue(orgId!);
      return res.data ?? null;
    },
  );

  // Plans list is gated by improvement_agent_v1 — probe so queue is not a silent empty when flag is off.
  const featureGateQuery = useOrgQuery(
    queryKeys.improve.featureGate(orgId),
    orgId,
    async () => {
      try {
        await improvePlansApi.listPlans(orgId!, "limit=1");
        return { enabled: true as const };
      } catch (e) {
        if (isImprovementAgentDisabled(e)) {
          return { enabled: false as const };
        }
        // Other errors (network, 5xx) are not "flag off" — leave queue usable.
        return { enabled: true as const };
      }
    },
  );

  const items = queueQuery.data?.items ?? [];
  const refreshedAt = queueQuery.data?.refreshed_at ?? null;
  const loading = queueQuery.isLoading || featureGateQuery.isLoading;
  const error = queueQuery.error?.message ?? null;
  const featureDisabled = featureGateQuery.data?.enabled === false;

  const load = () => queueQuery.refetch();

  const byColumn = useMemo(() => {
    const map: Record<string, ImproveQueueItem[]> = {};
    for (const col of COLUMNS) map[col.id] = [];
    for (const item of items) {
      const key = COLUMNS.some((c) => c.id === item.column)
        ? item.column
        : "needs_you";
      map[key].push(item);
    }
    for (const col of COLUMNS) {
      map[col.id].sort((a, b) => {
        const sev = severityRank(a.severity) - severityRank(b.severity);
        if (sev !== 0) return sev;
        return String(a.title).localeCompare(String(b.title));
      });
    }
    return map;
  }, [items]);

  const approveMutation = useOrgMutation(
    (item: ImproveQueueItem) => improveApi.approve(orgId!, item.ref),
    { invalidateKeys: [queryKeys.improve.queue(orgId)] },
  );

  const snoozeMutation = useOrgMutation(
    (item: ImproveQueueItem) => improveApi.snooze(orgId!, item.ref, 24),
    { invalidateKeys: [queryKeys.improve.queue(orgId)] },
  );

  const onApprove = async (item: ImproveQueueItem) => {
    if (!currentOrg) return;
    setBusyRef(item.ref);
    try {
      const res = await approveMutation.mutateAsync(item);
      const payload = res.data ?? {};
      const nested =
        payload.result && typeof payload.result === "object"
          ? (payload.result as { status?: string; pr_url?: string; message?: string })
          : null;
      const status =
        (typeof payload.status === "string" ? payload.status : null) ??
        nested?.status ??
        null;
      const prUrl = nested?.pr_url;
      // Real success only — F68 stubs return 501/not_implemented;
      // never toast "Approved" on unsupported/no-op responses.
      const realSuccess =
        status === "pr_opened" ||
        status === "promoted" ||
        status === "promotion_queued";
      if (!realSuccess) {
        const reason =
          (typeof payload.message === "string" && payload.message) ||
          nested?.message ||
          (status ? `Approve returned ${status}` : "Approve did not succeed");
        toast.error(
          isRepoNotConnected(reason) ? REPO_NOT_CONNECTED_MESSAGE : reason,
        );
        return;
      }
      if (status === "pr_opened") {
        toast.success(prUrl ? "PR opened" : "Approved — PR opened");
      } else {
        toast.success(nested?.message || payload.message || "Approved");
      }
    } catch (e) {
      if (isRepoNotConnected(e)) {
        toast.error(REPO_NOT_CONNECTED_MESSAGE);
      } else if (isImprovementAgentDisabled(e)) {
        toast.error(errorFromCaught(e, "Feature disabled — ask an admin"));
      } else {
        toast.error(errorFromCaught(e, "Approve failed"));
      }
    } finally {
      setBusyRef(null);
    }
  };

  const onSnooze = async (item: ImproveQueueItem) => {
    if (!currentOrg) return;
    setBusyRef(item.ref);
    try {
      await snoozeMutation.mutateAsync(item);
      toast.success("Snoozed 24h");
    } catch (e) {
      toast.error(errorFromCaught(e, "Snooze failed"));
    } finally {
      setBusyRef(null);
    }
  };

  if (!currentOrg && !authError) return <NoOrgState feature="Improve" />;
  if (!currentOrg) return null;

  return (
    <CoreResourcePage
      size="wide"
      header={
        <PageHeader
          title="Improve"
          subtitle="Action queue, improvement plans, and sweep history."
          description="Needs traces and Agent Issues first. One queue for triage, patches, nudges, and promotions."
          actions={
            tab === "queue" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load()}
                disabled={loading}
                aria-label="Refresh improvement queue"
              >
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                Refresh
              </Button>
            ) : undefined
          }
        />
      }
      toolbar={
        <div className="space-y-3">
          <CrossLinkBar
            links={[
              { label: "Issues", href: "/issues" },
              { label: "Artifacts", href: "/artifacts" },
              { label: "Promotions", href: "/promotions" },
              { label: "Scorecard", href: "/improve/scorecard" },
            ]}
          />
          <div role="tablist" aria-label="Improve sections" className="flex gap-1 border-b border-[var(--border-subtle)]">
          {IMPROVE_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "px-3 py-2 text-sm font-medium capitalize border-b-2 -mb-px",
                tab === t
                  ? "border-[var(--accent)] text-[var(--text-primary)]"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]",
              )}
            >
              {t === "queue" ? "Queue" : t === "plans" ? "Plans" : "History"}
            </button>
          ))}
          </div>
        </div>
      }
      table={
        <>
        {tab === "plans" && (
          <EmbeddedSurface>
            <PlansView />
          </EmbeddedSurface>
        )}
        {tab === "history" && (
          <EmbeddedSurface>
            <HistoryView />
          </EmbeddedSurface>
        )}
        {tab === "queue" && (
          <>
        {featureDisabled ? (
          <ImproveFeatureDisabledState />
        ) : (
          <>
        {error && (
          <ErrorState
            className="mb-4"
            title="Could not load the improvement queue"
            message={error}
            action={
              <Button onClick={() => void load()} variant="outline" size="default">
                <RefreshCw className="h-4 w-4" />
                Try again
              </Button>
            }
          />
        )}
        {refreshedAt && (
          <p className="mb-4 text-xs text-[var(--text-muted)]">
            Updated {new Date(refreshedAt).toLocaleString()}
          </p>
        )}
        {loading && items.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading queue…
          </div>
        ) : !error && items.length === 0 ? (
          <EmptyState
            variant="plain"
            title="Nothing in the queue"
            description={
              canManageKeys
                ? "Needs production traces and Agent Issues first. Create an API key, install the SDK or gateway from the docs, then return when Eden has signals to triage."
                : "Needs production traces and Agent Issues first. Ask an admin for an API key, or open Traces once data is flowing."
            }
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button asChild className="min-h-11">
                  <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                    Docs quickstart
                  </a>
                </Button>
                {canManageKeys ? (
                  <Button asChild variant="outline" className="min-h-11">
                    <Link href="/settings?tab=api-keys">Create API key</Link>
                  </Button>
                ) : (
                  <Button asChild variant="outline" className="min-h-11">
                    <Link href="/traces">Open Traces</Link>
                  </Button>
                )}
                <Button asChild variant="ghost" className="min-h-11">
                  <Link href="/issues">View Issues</Link>
                </Button>
              </div>
            }
          />
        ) : items.length === 0 ? null : (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            {COLUMNS.map((col) => (
              <Panel
                key={col.id}
                tone="flat"
                padding="sm"
                aria-label={col.label}
                className="min-h-[12rem]"
              >
                <header className="mb-3 px-1">
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                    {col.label}
                    <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                      {byColumn[col.id]?.length ?? 0}
                    </span>
                  </h2>
                  <p className="text-xs text-[var(--text-muted)]">{col.hint}</p>
                </header>
                <VirtualizedList
                  items={byColumn[col.id] ?? []}
                  rowKey={(item) => item.ref}
                  rowHeight={120}
                  className="max-h-[28rem] space-y-1.5"
                >
                  {(item) => {
                    const href = planHref(item);
                    const kind = planKindFromItem(item);
                    return (
                    <div
                      key={item.ref}
                      className="rounded-md bg-[var(--bg-primary)]/60 p-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          {href ? (
                            <Link
                              href={href}
                              className="block truncate text-sm font-medium text-[var(--text-primary)] hover:underline"
                            >
                              {item.title}
                            </Link>
                          ) : (
                            <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                              {item.title}
                            </p>
                          )}
                          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                            <span className={severityClass(item.severity)}>
                              {item.severity}
                            </span>
                            {" · "}
                            {item.item_type}
                            {item.source ? ` · ${item.source}` : ""}
                          </p>
                          {kind && (
                            <div className="mt-1">
                              <PlanKindBadge kind={kind} />
                            </div>
                          )}
                          {item.item_type === "auto_heal" && (
                            <p className="mt-1 text-[11px] text-[var(--accent)]">
                              Auto-heal event
                            </p>
                          )}
                          {item.item_type === "policy_denial" && (
                            <p className="mt-1 text-[11px] text-[var(--error)]">
                              Policy denial
                            </p>
                          )}
                          {item.blocked_reason && (
                            <p
                              className={cn(
                                "mt-1 text-[11px]",
                                item.item_type === "policy_denial"
                                  ? "text-[var(--error)]"
                                  : "text-[var(--warning)]",
                              )}
                            >
                              {item.item_type === "policy_denial"
                                ? "Denied: "
                                : "Blocked: "}
                              {item.blocked_reason}
                            </p>
                          )}
                          {item.autonomy_tier_required && (
                            <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                              Tier {item.autonomy_tier_required} required
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex gap-1">
                        {canApproveQueueItem(item) ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={busyRef === item.ref}
                            onClick={() => void onApprove(item)}
                          >
                            <Check className="mr-1 h-3 w-3" />
                            Approve
                          </Button>
                        ) : null}
                        {(item.column === "proposed" ||
                          item.column === "needs_you") &&
                          !canApproveQueueItem(item) &&
                          (item.blocked_reason ||
                            isLegacyProposedPatch(item) ||
                            item.ref.startsWith("promotion:") ||
                            item.item_type === "nudge_shadow") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              disabled
                              title={
                                item.blocked_reason
                                  ? `Approve disabled: ${item.blocked_reason}`
                                  : isLegacyProposedPatch(item)
                                    ? "Legacy Cat 23 patches are read-only — open Improvement plans"
                                    : "Approve not supported for this item type"
                              }
                            >
                              <Check className="mr-1 h-3 w-3" />
                              Approve
                            </Button>
                          )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          disabled={busyRef === item.ref}
                          onClick={() => void onSnooze(item)}
                        >
                          <Clock className="mr-1 h-3 w-3" />
                          Snooze
                        </Button>
                      </div>
                    </div>
                    );
                  }}
                </VirtualizedList>
              </Panel>
            ))}
          </div>
        )}
          </>
        )}
          </>
        )}
        </>
      }
    />
  );
}
