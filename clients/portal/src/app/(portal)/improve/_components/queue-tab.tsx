"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ListTodo } from "lucide-react";
import {
  improveApi,
  type ImproveQueueItem,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";
import {
  isImprovementAgentDisabled,
  IMPROVE_FEATURE_DISABLED_DESCRIPTION,
} from "@/lib/improve-feature";
import { ResourcePageShell } from "@/components/shell/resource-page-shell";
import { DetailPanelShell } from "@/components/shell/detail-panel-shell";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { EvidenceStrip, RelatedStrip } from "@/components/improve";
import { useImproveUrlState } from "../_hooks/use-improve-url-state";
import type { ImproveQueueStatus } from "@/lib/improve-url";

export type QueueTabProps = {
  canMutate: boolean;
};

function useIsXl() {
  const [isXl, setIsXl] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const apply = () => setIsXl(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return isXl;
}

function mapStatusToColumn(status?: ImproveQueueStatus): string {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "verify":
      return "verify";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "needs_you":
    default:
      return "needs_you";
  }
}

function itemMatchesView(item: ImproveQueueItem, status?: ImproveQueueStatus) {
  const col = (item.column || item.status || "").toLowerCase();
  const want = mapStatusToColumn(status);
  if (want === "needs_you") {
    return (
      col.includes("needs") ||
      col === "pending_review" ||
      col === "needs_you" ||
      col === "awaiting" ||
      col === "blocked"
    );
  }
  if (want === "in_progress") {
    return (
      col.includes("progress") ||
      col === "in_progress" ||
      col === "running" ||
      col === "pr_opened"
    );
  }
  if (want === "verify") {
    return (
      col.includes("verify") ||
      col === "verify" ||
      col === "merged" ||
      col === "done"
    );
  }
  return true;
}

export function QueueTab({ canMutate }: QueueTabProps) {
  const t = useTranslations("improve");
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const { state, setState, clearSelection } = useImproveUrlState();
  const isXl = useIsXl();
  const selectedRef = state.planId;

  const queueQuery = useOrgQuery(
    queryKeys.improve.queue(orgId, { agentId: state.agentId }),
    orgId,
    () =>
      improveApi.queue(orgId!, {
        agent_id: state.agentId,
        limit: 100,
      }),
  );

  const approveMutation = useOrgMutation(
    (itemRef: string) => improveApi.approve(orgId!, itemRef),
    {
      onSuccess: () => void queueQuery.refetch(),
      onError: (err) => {
        if (isImprovementAgentDisabled(err)) {
          toast.error(IMPROVE_FEATURE_DISABLED_DESCRIPTION);
          return;
        }
        toast.error(err instanceof Error ? err.message : t("errors.approve"));
      },
    },
  );

  const snoozeMutation = useOrgMutation(
    (itemRef: string) => improveApi.snooze(orgId!, itemRef, 24),
    {
      onSuccess: () => void queueQuery.refetch(),
      onError: (err) => {
        toast.error(err instanceof Error ? err.message : t("errors.snooze"));
      },
    },
  );

  const items = useMemo(() => {
    const raw = queueQuery.data?.data?.items ?? [];
    return raw;
  }, [queueQuery.data]);

  const filtered = useMemo(() => {
    const q = (state.q ?? "").trim().toLowerCase();
    return items.filter((item) => {
      if (!itemMatchesView(item, state.status ?? "needs_you")) return false;
      if (state.agentId && item.agent_id && item.agent_id !== state.agentId) {
        return false;
      }
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.ref.toLowerCase().includes(q) ||
        (item.agent_id ?? "").toLowerCase().includes(q)
      );
    });
  }, [items, state.q, state.status, state.agentId]);

  const selected =
    filtered.find((i) => i.ref === selectedRef) ??
    items.find((i) => i.ref === selectedRef) ??
    null;

  const columns: DataTableColumn<ImproveQueueItem>[] = [
    {
      key: "title",
      header: t("queue.col.title"),
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-[var(--text-primary)]">
            {row.title}
          </div>
          <div className="font-mono text-xs text-[var(--text-muted)]">
            {row.ref}
          </div>
        </div>
      ),
    },
    {
      key: "severity",
      header: t("queue.col.severity"),
      cell: (row) => <StatusBadge status={row.severity || "info"} />,
    },
    {
      key: "agent",
      header: t("queue.col.agent"),
      cell: (row) => row.agent_id ?? "—",
    },
    {
      key: "status",
      header: t("queue.col.status"),
      cell: (row) => <StatusBadge status={row.column || row.status} />,
    },
  ];

  const detailOpen = Boolean(selectedRef);
  const filtersActive = Boolean(state.q || state.agentId);

  function primaryCta(item: ImproveQueueItem) {
    if (!canMutate) return null;
    const col = (item.column || item.status || "").toLowerCase();
    if (col.includes("verify") || col === "merged") {
      return (
        <Button
          type="button"
          size="sm"
          className="min-h-11"
          loading={approveMutation.isPending}
          onClick={() => void approveMutation.mutateAsync(item.ref)}
        >
          {t("queue.cta.verify")}
        </Button>
      );
    }
    return (
      <Button
        type="button"
        size="sm"
        className="min-h-11"
        loading={approveMutation.isPending}
        onClick={() => void approveMutation.mutateAsync(item.ref)}
      >
        {t("queue.cta.approve")}
      </Button>
    );
  }

  const detailBody = selected ? (
    <div className="space-y-4 p-4" data-testid="queue-detail">
      <p className="text-sm text-[var(--text-secondary)]">
        {selected.blocked_reason || t("queue.detail.summary")}
      </p>
      <EvidenceStrip
        links={[
          selected.href
            ? { href: selected.href, label: t("queue.detail.openSource") }
            : null,
          selected.agent_id
            ? {
                href: `/agents/${encodeURIComponent(selected.agent_id)}`,
                label: selected.agent_id,
              }
            : null,
        ].filter(Boolean) as Array<{ href: string; label: string }>}
      />
      <div className="flex flex-wrap gap-2">
        {primaryCta(selected)}
        {canMutate ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="min-h-11"
            loading={snoozeMutation.isPending}
            onClick={() => void snoozeMutation.mutateAsync(selected.ref)}
          >
            {t("queue.cta.snooze")}
          </Button>
        ) : null}
        <Button asChild size="sm" variant="ghost" className="min-h-11">
          <Link
            href={`/improve/plans/${encodeURIComponent(selected.ref)}`}
          >
            {t("queue.cta.openPlan")}
          </Link>
        </Button>
      </div>
      <RelatedStrip
        links={[
          { href: "/issues", label: t("related.issues") },
          { href: "/improve?tab=artifacts", label: t("related.artifacts") },
          { href: "/improve?tab=ledger", label: t("related.ledger") },
        ]}
      />
    </div>
  ) : null;

  return (
    <div data-testid="improve-queue-tab">
      <ResourcePageShell
        table={
          <QueryState
            loading={queueQuery.isLoading}
            error={queueQuery.error}
            data={filtered}
            onRetry={() => void queueQuery.refetch()}
            isEmpty={(rows) => rows.length === 0}
            filtersActive={filtersActive}
            loadingSlot={
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            }
            emptySlot={
              <EmptyState
                icon={ListTodo}
                title={t("queue.empty.title")}
                description={t("queue.empty.body")}
                action={
                  <Button asChild size="sm" className="min-h-11">
                    <Link href="/issues">{t("queue.empty.cta")}</Link>
                  </Button>
                }
              />
            }
            filterEmptySlot={
              <EmptyState
                title={t("queue.filterEmpty.title")}
                description={t("queue.filterEmpty.body")}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="min-h-11"
                    onClick={() => setState({ q: undefined, agentId: undefined })}
                  >
                    {t("queue.filterEmpty.clear")}
                  </Button>
                }
              />
            }
          >
            {(rows) => (
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.ref}
                highlightRowId={selectedRef}
                onRowClick={(row) => setState({ planId: row.ref })}
              />
            )}
          </QueryState>
        }
        detail={
          detailOpen && isXl && selected ? (
            <DetailPanelShell
              open
              onClose={clearSelection}
              title={selected.title}
              mobileDrawer={false}
            >
              {detailBody}
            </DetailPanelShell>
          ) : undefined
        }
      />

      {detailOpen && !isXl && selected ? (
        <DetailPanelShell
          open
          onClose={clearSelection}
          title={selected.title}
          mobileDrawer
        >
          {detailBody}
        </DetailPanelShell>
      ) : null}
    </div>
  );
}
