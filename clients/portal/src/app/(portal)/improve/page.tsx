"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Check, Clock, Loader2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage, CrossLinkBar } from "@/components/portal-os";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import {
  improveApi,
  type ImproveQueueItem,
} from "@/lib/api";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { errorFromCaught } from "@/lib/safe-error-message";
import { PlanKindBadge } from "@/components/improve/plan-kind-badge";
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

function planHref(item: ImproveQueueItem): string | null {
  if (item.item_type === "improvement_plan" || item.ref.startsWith("improvement_plan:")) {
    const id = item.ref.includes(":") ? item.ref.split(":").slice(1).join(":") : item.ref;
    return `/improve/plans/${id}`;
  }
  if (item.item_type === "proposed_patch" || item.ref.startsWith("proposed_patch:")) {
    const id = item.ref.split(":")[1];
    if (id) return `/improve/plans/${id}`;
  }
  const payloadPlanId = item.payload?.plan_id ?? item.payload?.patch_id;
  if (typeof payloadPlanId === "string" && payloadPlanId) {
    return `/improve/plans/${payloadPlanId}`;
  }
  if (item.href?.startsWith("/pr-suggestions")) {
    return item.href.replace("/pr-suggestions", "/improve/plans");
  }
  return item.href ?? null;
}

function planKindFromItem(item: ImproveQueueItem): ImprovementPlanKind | null {
  const kind = item.payload?.plan_kind;
  if (typeof kind === "string" && kind) return kind as ImprovementPlanKind;
  if (item.item_type === "improvement_plan" || item.item_type === "proposed_patch") {
    return "code_patch";
  }
  return null;
}

export default function ImprovePage() {
  return (
    <Suspense fallback={<TabLoading />}>
      <ImprovePageInner />
    </Suspense>
  );
}

function ImprovePageInner() {
  const { currentOrg } = useOrg();
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

  const items = queueQuery.data?.items ?? [];
  const refreshedAt = queueQuery.data?.refreshed_at ?? null;
  const loading = queueQuery.isLoading;
  const error = queueQuery.error?.message ?? null;

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
      await approveMutation.mutateAsync(item);
      toast.success("Approved");
    } catch (e) {
      toast.error(errorFromCaught(e, "Approve failed"));
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

  if (!currentOrg) return <NoOrgState feature="Improve" />;

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
        <div className="mb-4 space-y-3">
          <CrossLinkBar
            links={[
              { label: "Issues", href: "/issues" },
              { label: "Artifacts", href: "/artifacts" },
              { label: "Promotions", href: "/promotions" },
              { label: "Scorecard", href: "/improve/scorecard" },
              { label: "Change impact", href: "/improve/change-impact" },
              { label: "Online scoring", href: "/improve/online-scoring" },
              { label: "Book / Drift", href: "/agents" },
            ]}
          />
          <div role="tablist" aria-label="Improve sections" className="flex gap-1 border-b border-[var(--border-default)]">
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
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing in the queue"
            description="Needs production traces and Agent Issues first. Create an API key, install the SDK or gateway from the docs, then return when Eden has signals to triage."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <a href={DOCS_QUICKSTART_URL} target="_blank" rel="noopener noreferrer">
                  <Button className="min-h-11">Docs quickstart</Button>
                </a>
                <Link href="/settings?tab=api-keys">
                  <Button variant="outline" className="min-h-11">Create API key</Button>
                </Link>
                <Link href="/issues">
                  <Button variant="outline" className="min-h-11">View Issues</Button>
                </Link>
              </div>
            }
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            {COLUMNS.map((col) => (
              <section
                key={col.id}
                aria-label={col.label}
                className="min-h-[12rem] rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3"
              >
                <header className="mb-3">
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                    {col.label}
                    <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                      {byColumn[col.id]?.length ?? 0}
                    </span>
                  </h2>
                  <p className="text-xs text-[var(--text-muted)]">{col.hint}</p>
                </header>
                <ul className="space-y-2">
                  {(byColumn[col.id] ?? []).map((item) => {
                    const href = planHref(item);
                    const kind = planKindFromItem(item);
                    return (
                    <li
                      key={item.ref}
                      className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] p-2.5"
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
                        {(item.column === "proposed" ||
                          item.column === "needs_you") &&
                          (item.ref.startsWith("closed_loop:") ||
                            item.ref.startsWith("promotion:") ||
                            item.item_type === "nudge_shadow") && (
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
                    </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
          </>
        )}
        </>
      }
    />
  );
}
