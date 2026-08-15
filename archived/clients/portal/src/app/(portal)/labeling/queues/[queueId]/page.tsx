"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import {
  labelingApi,
  type LabelingKanbanItem,
  type LabelingKanbanStatus,
} from "@/lib/api/labeling";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";
import { formatRelativeTime } from "@/lib/format";

const KANBAN_COLUMNS: { status: LabelingKanbanStatus; label: string; accent: string }[] = [
  { status: "todo", label: "To do", accent: "bg-[var(--accent)]" },
  { status: "in_progress", label: "In progress", accent: "bg-[var(--warning)]" },
  { status: "done", label: "Done", accent: "bg-[var(--terminal)]" },
  { status: "skipped", label: "Skipped", accent: "bg-[var(--text-faint)]" },
];

function cardPreview(item: LabelingKanbanItem): string {
  if (item.prompt) return item.prompt;
  if (item.payload) {
    const label = item.payload.label;
    if (typeof label === "string") return label;
    if (label && typeof label === "object") {
      const winner = (label as { winner?: unknown }).winner;
      if (winner) return `Winner: ${String(winner)}`;
    }
    return `Item ${item.id.slice(0, 8)}`;
  }
  return `Item ${item.id.slice(0, 8)}`;
}

/**
 * `/labeling/queues/[queueId]` — F50 kanban board (FEAT-80).
 *
 * Columns todo / in_progress / done / skipped backed by
 * `GET .../labeling/queues/{queue_id}/board` with per-card
 * "Move to →" dropdowns (no drag-and-drop library is installed in the
 * portal, so v1 ships the dropdown interaction). An IAA summary strip
 * on top reads the queue's agreement endpoint.
 */
function KanbanInner({ queueId }: { queueId: string }) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { pushToast } = useLabToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const queueQuery = useOrgQuery(
    queryKeys.labeling.queues(orgId),
    orgId,
    () => labelingApi.listQueues(orgId!),
    SHELL_QUERY,
  );
  const boardQuery = useOrgQuery(
    queryKeys.labeling.board(orgId, queueId),
    orgId,
    () => labelingApi.queueBoard(orgId!, queueId),
    SHELL_QUERY,
  );
  // IAA strip is best-effort — a queue with no dual-labeled items yet
  // reports zeros rather than failing the board.
  const iaaQuery = useOrgQuery(
    queryKeys.labeling.agreement(orgId),
    orgId,
    () => labelingApi.queueAgreement(orgId!, queueId),
    { ...SHELL_QUERY, retry: false },
  );

  const queue = queueQuery.data?.queues.find((q) => q.id === queueId);
  const board = boardQuery.data?.board;
  const iaa = iaaQuery.data?.iaa;

  const moveMutation = useOrgMutation(
    async ({ itemId, status }: { itemId: string; status: LabelingKanbanStatus }) => {
      const res = await labelingApi.moveItem(orgId!, queueId, itemId, status);
      if (!res.moved) throw new Error(`move returned moved=false for ${itemId}`);
      return res;
    },
    {
      invalidateKeys: [queryKeys.labeling.board(orgId, queueId)],
      onSuccess: (_data, { itemId, status }) => {
        pushToast({
          title: "Card moved",
          body: `${itemId.slice(0, 8)} → ${status.replace("_", " ")}`,
          tone: "ok",
        });
      },
      onError: (err: Error) => {
        pushToast({
          title: "Move failed",
          body: err.message,
          tone: "fail",
        });
      },
    },
  );

  const total = useMemo(() => {
    if (!board) return 0;
    return Object.values(board).reduce((n, items) => n + items.length, 0);
  }, [board]);

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Labeling queue"
        message="Select a workspace to view this labeling queue."
      />
    );
  }

  if (boardQuery.isLoading || queueQuery.isLoading) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Kanban" />
        <QueryLoadingPanel label="Loading kanban board…" />
      </div>
    );
  }

  if (boardQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Kanban" />
        <QueryErrorPanel
          error={boardQuery.error}
          onRetry={() => void boardQuery.refetch()}
        />
      </div>
    );
  }

  const meta = (
    <span className="type-meta">
      {total} item{total === 1 ? "" : "s"} · queue {queueId.slice(0, 8)}
      {typeof iaa?.kappa === "number"
        ? ` · κ ${iaa.kappa.toFixed(2)}`
        : ""}
    </span>
  );

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={queue?.name ?? "Kanban"}
        meta={meta}
        actions={
          <Link
            href="/labeling"
            className="ds-btn ds-btn-outline"
            aria-label="Back to labeling"
          >
            <ChevronLeft className="h-4 w-4" />
            Labeling
          </Link>
        }
      />

      {/* IAA summary strip (FEAT-80 depends on the #79 agreement consolidation). */}
      <div className="border-b border-[var(--line)] px-4 py-2.5 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <span className="type-meta">Inter-annotator agreement</span>
          {typeof iaa?.kappa === "number" ? (
            <>
              <span className="type-meta text-[var(--text-muted)]">
                κ <strong className="type-ui text-[var(--text)]">{iaa.kappa.toFixed(2)}</strong>
              </span>
              <span className="type-meta text-[var(--text-muted)]">
                agreement{" "}
                <strong className="type-ui text-[var(--text)]">
                  {(Number(iaa.agreement_rate ?? 0) * 100).toFixed(0)}%
                </strong>
              </span>
              <span className="type-meta text-[var(--text-muted)]">
                {Number(iaa.n ?? 0)} annotation{Number(iaa.n ?? 0) === 1 ? "" : "s"}
              </span>
            </>
          ) : (
            <span className="type-meta text-[var(--text-muted)]">
              No dual-labeled items yet — label the same item twice to see κ.
            </span>
          )}
        </div>
      </div>

      {total === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-5">
          <EmptyState
            title="Empty board"
            body="This queue has no items yet. Seed items via the labeling API to fill the board."
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto p-3 sm:p-4 md:grid-cols-2 xl:grid-cols-4">
          {KANBAN_COLUMNS.map((col) => {
            const items = board?.[col.status] ?? [];
            return (
              <section
                key={col.status}
                className="flex min-h-[8rem] flex-col rounded-lg border border-[var(--line)] bg-[var(--bg-elevated)]"
                aria-label={`${col.label} column`}
              >
                <header className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
                  <span className={`h-2 w-2 rounded-full ${col.accent}`} aria-hidden />
                  <h3 className="type-ui text-[var(--text-secondary)]">{col.label}</h3>
                  <span className="ml-auto type-meta text-[var(--text-faint)]">
                    {items.length}
                  </span>
                </header>
                <ul className="flex min-h-0 flex-1 flex-col gap-2 p-2">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className="group rounded-md border border-[var(--line)] bg-[var(--bg)] p-2.5 transition-colors hover:border-[var(--accent)]"
                    >
                      <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm">
                        {cardPreview(item)}
                      </p>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="type-meta text-[var(--text-faint)]">
                          {formatRelativeTime(item.created_at)}
                        </span>
                        <label className="flex items-center gap-1">
                          <span className="sr-only">Move to</span>
                          <select
                            className="h-7 rounded-md border border-[var(--line)] bg-[var(--bg)] px-1.5 text-xs text-[var(--text-secondary)] focus-visible:border-[var(--accent)] focus-visible:outline-none"
                            value={item.kanban_status}
                            disabled={busyId === item.id}
                            onChange={(e) => {
                              const next = e.target.value as LabelingKanbanStatus;
                              if (next === item.kanban_status) return;
                              setBusyId(item.id);
                              void moveMutation
                                .mutateAsync({ itemId: item.id, status: next })
                                .finally(() => setBusyId(null));
                            }}
                          >
                            {KANBAN_COLUMNS.map((c) => (
                              <option key={c.status} value={c.status}>
                                Move to {c.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </li>
                  ))}
                  {items.length === 0 && (
                    <li className="flex h-16 items-center justify-center">
                      <span className="type-meta text-[var(--text-faint)]">Empty</span>
                    </li>
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function QueueKanbanPage() {
  const params = useParams<{ queueId: string }>();
  const queueId = params?.queueId;
  if (!queueId) {
    return <NoWorkspaceGuard title="Labeling queue" message="Missing queue id." />;
  }
  return <KanbanInner queueId={queueId} />;
}
