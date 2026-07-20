"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Check, ChevronDown, Clock, Loader2, RefreshCw } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage, VirtualizedList } from "@/components/portal-os";
import { EmbeddedSurface } from "@/components/layout/embedded-surface";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Panel } from "@/components/ui/panel";
import { QueryState } from "@/components/ui/query-state";
import { LoadingSkeleton } from "@/components/ui/skeleton";
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
import { U20_EMPTY_COPY } from "@/lib/portal-polish";

/** Moat / loop links — overflow only (no peer CrossLink band). */
const PATH_LINKS = [
  { label: "Issues", href: "/issues" },
  { label: "Artifacts", href: "/artifacts" },
  { label: "Promotions", href: "/promotions" },
  { label: "Ledger", href: "/ledger" },
  { label: "Scorecard", href: "/improve/scorecard" },
  { label: "Online scoring", href: "/improve/online-scoring" },
] as const;

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

/** Desktop kanban row estimate — title + status + meta + min-h-11 actions. */
const QUEUE_CARD_ROW_HEIGHT = 152;

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

function QueueItemCard({
  item,
  busy,
  onApprove,
  onSnooze,
}: {
  item: ImproveQueueItem;
  busy: boolean;
  onApprove: (item: ImproveQueueItem) => void;
  onSnooze: (item: ImproveQueueItem) => void;
}) {
  const href = planHref(item);
  const kind = planKindFromItem(item);
  const showDisabledApprove =
    (item.column === "proposed" || item.column === "needs_you") &&
    !canApproveQueueItem(item) &&
    Boolean(
      item.blocked_reason ||
        isLegacyProposedPatch(item) ||
        item.ref.startsWith("promotion:") ||
        item.item_type === "nudge_shadow",
    );

  return (
    <article className="rounded-md bg-[var(--bg-primary)]/60 p-space-3 flex flex-col gap-space-2">
      {href ? (
        <Link
          href={href}
          className="block text-sm font-medium leading-snug text-[var(--text-primary)] hover:underline line-clamp-2"
        >
          {item.title}
        </Link>
      ) : (
        <p className="text-sm font-medium leading-snug text-[var(--text-primary)] line-clamp-2">
          {item.title}
        </p>
      )}

      <p className={cn("text-xs font-medium capitalize", severityClass(item.severity))}>
        {item.severity}
      </p>

      {item.item_type === "auto_heal" ? (
        <p className="text-2xs text-[var(--accent)]">Auto-heal event</p>
      ) : null}
      {item.item_type === "policy_denial" ? (
        <p className="text-2xs text-[var(--error)]">Policy denial</p>
      ) : null}

      <p className="text-2xs text-[var(--text-muted)]">
        {item.item_type}
        {item.source ? ` · ${item.source}` : ""}
        {item.autonomy_tier_required ? ` · Tier ${item.autonomy_tier_required}` : ""}
      </p>

      {kind ? (
        <div>
          <PlanKindBadge kind={kind} />
        </div>
      ) : null}

      {item.blocked_reason ? (
        <p
          className={cn(
            "text-2xs",
            item.item_type === "policy_denial"
              ? "text-[var(--error)]"
              : "text-[var(--warning)]",
          )}
        >
          {item.item_type === "policy_denial" ? "Denied: " : "Blocked: "}
          {item.blocked_reason}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-space-2 pt-space-1">
        {canApproveQueueItem(item) ? (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 px-space-3 text-xs"
            disabled={busy}
            onClick={() => void onApprove(item)}
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            Approve
          </Button>
        ) : null}
        {showDisabledApprove ? (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 px-space-3 text-xs"
            disabled
            title={
              item.blocked_reason
                ? `Approve disabled: ${item.blocked_reason}`
                : isLegacyProposedPatch(item)
                  ? "Legacy Cat 23 patches are read-only — open Improvement plans"
                  : "Approve not supported for this item type"
            }
          >
            <Check className="mr-1 h-3.5 w-3.5" />
            Approve
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="min-h-11 px-space-3 text-xs"
          disabled={busy}
          onClick={() => void onSnooze(item)}
        >
          <Clock className="mr-1 h-3.5 w-3.5" />
          Snooze
        </Button>
      </div>
    </article>
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
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as (typeof IMPROVE_TABS)[number])}
    >
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
                className="min-h-11"
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
        <div
          data-testid="improve-toolbar"
          className="flex flex-wrap items-center gap-space-2 border-b border-[var(--border-subtle)] pb-space-1"
        >
          <TabsList
            variant="underline"
            aria-label="Improve sections"
            className="h-auto min-w-0 flex-1 justify-start gap-space-1 overflow-x-auto bg-transparent"
          >
            {IMPROVE_TABS.map((t) => {
              const label =
                t === "queue" ? "Queue" : t === "plans" ? "Plans" : "History";
              return (
                <TabsTrigger
                  key={t}
                  variant="underline"
                  value={t}
                  title={label}
                  className="min-h-11 shrink-0 capitalize"
                >
                  {label}
                </TabsTrigger>
              );
            })}
          </TabsList>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="min-h-11 shrink-0"
                aria-label="Improve path links"
              >
                <span className="hidden sm:inline">More</span>
                <span className="sm:hidden">More</span>
                <ChevronDown className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              <DropdownMenuLabel>Go to</DropdownMenuLabel>
              {PATH_LINKS.map((l) => (
                <DropdownMenuItem key={l.href} asChild>
                  <Link href={l.href}>{l.label}</Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
      table={
        <>
        <TabsContent value="plans" className="mt-0">
          <EmbeddedSurface>
            <PlansView />
          </EmbeddedSurface>
        </TabsContent>
        <TabsContent value="history" className="mt-0">
          <EmbeddedSurface>
            <HistoryView />
          </EmbeddedSurface>
        </TabsContent>
        <TabsContent value="queue" className="mt-0">
          <>
        {featureDisabled ? (
          <ImproveFeatureDisabledState />
        ) : (
          <>
        {refreshedAt && (
          <p className="mb-space-4 text-xs text-[var(--text-muted)]">
            Updated {new Date(refreshedAt).toLocaleString()}
          </p>
        )}
        <QueryState
          loading={loading && items.length === 0}
          error={queueQuery.error}
          data={queueQuery.data}
          onRetry={() => void load()}
          errorTitle="Could not load the improvement queue"
          isEmpty={(d) => (d?.items.length ?? 0) === 0}
          loadingSlot={<LoadingSkeleton variant="table" lines={5} className="p-0 max-w-none" />}
          emptySlot={
            <EmptyState
              variant="plain"
              title="Nothing in the queue"
              description={U20_EMPTY_COPY.improveQueue}
              action={
                <div className="flex flex-wrap items-center justify-center gap-space-2">
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
          }
        >
          {() => (
          <>
          {/* UX-P1-01: &lt;lg = list/stack (populated columns only); lg+ = kanban grid */}
          <div className="flex flex-col gap-space-4 lg:hidden">
            {COLUMNS.map((col) => {
              const colItems = byColumn[col.id] ?? [];
              if (colItems.length === 0) return null;
              return (
                <section key={col.id} aria-label={col.label} className="flex flex-col gap-space-2">
                  <header className="px-space-1">
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                      {col.label}
                      <span className="ml-space-2 text-xs font-normal text-[var(--text-muted)]">
                        {colItems.length}
                      </span>
                    </h2>
                    <p className="text-xs text-[var(--text-muted)]">{col.hint}</p>
                  </header>
                  <ul className="flex flex-col gap-space-2 m-0 p-0 list-none">
                    {colItems.map((item) => (
                      <li key={item.ref}>
                        <QueueItemCard
                          item={item}
                          busy={busyRef === item.ref}
                          onApprove={onApprove}
                          onSnooze={onSnooze}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>

          <div className="hidden gap-space-3 lg:grid lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            {COLUMNS.map((col) => (
              <Panel
                key={col.id}
                tone="flat"
                padding="sm"
                aria-label={col.label}
                className="min-h-[12rem]"
              >
                <header className="mb-space-3 px-space-1">
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                    {col.label}
                    <span className="ml-space-2 text-xs font-normal text-[var(--text-muted)]">
                      {byColumn[col.id]?.length ?? 0}
                    </span>
                  </h2>
                  <p className="text-xs text-[var(--text-muted)]">{col.hint}</p>
                </header>
                <VirtualizedList
                  items={byColumn[col.id] ?? []}
                  rowKey={(item) => item.ref}
                  rowHeight={QUEUE_CARD_ROW_HEIGHT}
                  className="max-h-[28rem] flex flex-col gap-space-2"
                >
                  {(item) => (
                    <QueueItemCard
                      item={item}
                      busy={busyRef === item.ref}
                      onApprove={onApprove}
                      onSnooze={onSnooze}
                    />
                  )}
                </VirtualizedList>
              </Panel>
            ))}
          </div>
          </>
          )}
        </QueryState>
          </>
        )}
          </>
        </TabsContent>
        </>
      }
    />
    </Tabs>
  );
}
