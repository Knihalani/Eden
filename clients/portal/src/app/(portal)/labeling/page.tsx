"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ds/primitives";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { labelingApi } from "@/lib/api/labeling";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { LabelingQueueTable } from "@/lab/labeling/labeling-queue-table";
import { LabelingUnassignedPanel } from "@/lab/labeling/labeling-unassigned-panel";
import { sortItemsByDisagreement } from "@/lab/labeling/labeling-sort";
import { downloadFile } from "@/lib/export";
import { useLabToast } from "@/lab/lab-toast";

/**
 * `/labeling` — queue list + disagreement-first item pool (FEAT-82).
 * Backend: `src/eden/api/routes/labeling.py` (`GET .../labeling/queues`,
 * `GET .../labeling/items`, `GET .../labeling/iia`).
 */
function LabelingInner() {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { pushToast } = useLabToast();
  const [exporting, setExporting] = useState(false);

  const queuesQuery = useOrgQuery(
    queryKeys.labeling.queues(orgId),
    orgId,
    () => labelingApi.listQueues(orgId!),
    SHELL_QUERY,
  );
  const itemsQuery = useOrgQuery(
    queryKeys.labeling.items(orgId, { limit: 200 }),
    orgId,
    () => labelingApi.listItems(orgId!, { limit: 200 }),
    SHELL_QUERY,
  );
  // Agreement is best-effort — if the report fails to compute (e.g. no
  // dual-labeled items yet), the panel still renders, just unsorted by
  // agreement (annotated-first ordering still applies).
  const agreementQuery = useOrgQuery(
    queryKeys.labeling.agreement(orgId),
    orgId,
    () => labelingApi.agreement(orgId!),
    { ...SHELL_QUERY, retry: false },
  );

  const skipBulkMutation = useOrgMutation(
    (itemIds: string[]) => labelingApi.skipBulk(orgId!, { item_ids: itemIds }),
    {
      invalidateKeys: orgId
        ? [queryKeys.labeling.items(orgId, { limit: 200 }), queryKeys.labeling.agreement(orgId)]
        : undefined,
      onSuccess: (_data, itemIds) => {
        pushToast({
          title: `Skipped ${itemIds.length} item${itemIds.length === 1 ? "" : "s"}`,
          tone: "ok",
        });
      },
      onError: (err) =>
        pushToast({
          title: "Bulk skip failed",
          body: err instanceof Error ? err.message : String(err),
          tone: "fail",
        }),
    },
  );

  const queues = queuesQuery.data?.queues ?? [];
  const items = itemsQuery.data?.items ?? [];
  const perItem = agreementQuery.data?.per_item;

  const sortedItems = useMemo(
    () => sortItemsByDisagreement(items, perItem),
    [items, perItem],
  );

  const goToAnnotate = (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    router.push(`/labeling/annotate${qs ? `?${qs}` : ""}`);
  };

  const goToQueue = (queueId: string) => {
    router.push(`/labeling/queues/${encodeURIComponent(queueId)}`);
  };

  const exportJsonl = async () => {
    if (!orgId || exporting) return;
    setExporting(true);
    try {
      const body = await labelingApi.exportJsonl(orgId, { status: "completed" });
      const date = new Date().toISOString().slice(0, 10);
      downloadFile(
        `labeling-${orgId}-${date}.jsonl`,
        body,
        "application/x-ndjson;charset=utf-8",
      );
      pushToast({ title: "Exported labeling JSONL", tone: "ok" });
    } catch (err) {
      pushToast({
        title: "Export failed",
        body: err instanceof Error ? err.message : String(err),
        tone: "fail",
      });
    } finally {
      setExporting(false);
    }
  };

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Labeling"
        message="Select a workspace to view labeling queues."
      />
    );
  }

  if (queuesQuery.isLoading || itemsQuery.isLoading) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Labeling" />
        <QueryLoadingPanel label="Loading labeling queues…" />
      </div>
    );
  }

  if (queuesQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Labeling" />
        <QueryErrorPanel
          error={queuesQuery.error}
          onRetry={() => void queuesQuery.refetch()}
        />
      </div>
    );
  }

  if (itemsQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Labeling" />
        <QueryErrorPanel
          error={itemsQuery.error}
          onRetry={() => void itemsQuery.refetch()}
        />
      </div>
    );
  }

  const meta = (
    <span className="type-meta">
      {queues.length} queue{queues.length === 1 ? "" : "s"} · {items.length} item
      {items.length === 1 ? "" : "s"} in the pool
    </span>
  );

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Labeling"
        meta={meta}
        actions={
          <>
            <button
              type="button"
              className="ds-btn ds-btn-outline ds-btn-sm"
              disabled={exporting}
              onClick={() => void exportJsonl()}
            >
              {exporting ? "Exporting…" : "Export JSONL"}
            </button>
            <Link href="/labeling/iaa" className="ds-btn ds-btn-outline ds-btn-sm">
              IAA dashboard
            </Link>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 w-full flex-col border-b border-[var(--line)] lg:w-[26rem] lg:shrink-0 lg:border-b-0 lg:border-r">
          <div className="border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
            <h3 className="type-ui text-[var(--text-secondary)]">Queues</h3>
          </div>
          <LabelingQueueTable
            queues={queues}
            onSelect={goToQueue}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <LabelingUnassignedPanel
            items={sortedItems}
            perItem={perItem}
            onSelect={(itemId) => goToAnnotate({ item: itemId })}
            onStartLabeling={() => goToAnnotate({})}
            onSkipSelected={(itemIds) => skipBulkMutation.mutate(itemIds)}
            skipping={skipBulkMutation.isPending}
          />
        </div>
      </div>
    </div>
  );
}

export default function LabelingPage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page flex min-h-0 flex-1 items-center justify-center">
          <p className="type-meta">Loading labeling…</p>
        </div>
      }
    >
      <LabelingInner />
    </Suspense>
  );
}
