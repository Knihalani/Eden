"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { PageHeader } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import {
  labelingApi,
  type LabelingItem,
  type AnnotateRequestBody,
} from "@/lib/api/labeling";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";
import { AnnotateView, formatAnnotateSessionStats } from "@/lab/labeling/annotate-view";

const LEASE_SIZE = 10;

type UndoEntry = {
  item: LabelingItem;
  label: unknown;
  confidence: number;
  notes: string;
  timeSpentMs: number;
};

type ItemStartSnapshot = {
  label: unknown;
  confidence: number;
  notes: string;
};

/**
 * `/labeling/annotate` — keyboard-driven annotator work surface
 * (FEAT-83). Backend: `POST .../labeling/queue/{user_id}` (pop/lease),
 * `POST .../labeling/annotate`, `POST .../labeling/skip`.
 *
 * The backend has no get-item-by-id endpoint, so `?item=` (set when
 * arriving from the `/labeling` unassigned-items panel) is a
 * best-effort hint only: if the leased batch happens to include that
 * item it's moved to the front, otherwise the annotator just works
 * through the leased queue in order. `?queue=` is similarly
 * informational — the pop endpoint leases the next pending items
 * org-wide, not scoped to one F50 kanban queue, so it's shown as
 * context in the header rather than used to filter the lease.
 *
 * `?strategy=active_learning` opts into disagreement/uncertainty-ranked
 * pop (default FIFO).
 */
function AnnotateInner() {
  const searchParams = useSearchParams();
  const paramItem = searchParams.get("item");
  const paramQueue = searchParams.get("queue");
  const popStrategy =
    searchParams.get("strategy") === "active_learning" ? "active_learning" : "fifo";

  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { user } = useUser();
  const userId = user?.id ?? null;
  const { pushToast } = useLabToast();

  const popQuery = useOrgQuery(
    queryKeys.labeling.pop(orgId, userId, popStrategy),
    orgId,
    () => labelingApi.popQueue(orgId!, userId!, LEASE_SIZE, popStrategy),
    { ...SHELL_QUERY, enabled: Boolean(orgId && userId), staleTime: Infinity },
  );

  const [queue, setQueue] = useState<LabelingItem[]>([]);
  const seededKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!popQuery.data) return;
    // Only seed once per physical fetch (dataUpdatedAt changes on every
    // refetch, including the manual one we trigger once the local
    // queue is exhausted) — otherwise a background refetch would
    // silently reorder/replace the annotator's in-progress lease.
    const key = String(popQuery.dataUpdatedAt);
    if (seededKeyRef.current === key) return;
    seededKeyRef.current = key;

    let items = popQuery.data.items;
    if (paramItem) {
      const idx = items.findIndex((i) => i.id === paramItem);
      if (idx > 0) items = [items[idx]!, ...items.slice(0, idx), ...items.slice(idx + 1)];
    }
    setQueue(items);
  }, [popQuery.data, popQuery.dataUpdatedAt, paramItem]);

  const current = queue[0] ?? null;
  const queueItemIds = useMemo(() => queue.map((i) => i.id), [queue]);

  const agreementQuery = useOrgQuery(
    queryKeys.labeling.agreement(orgId, queueItemIds),
    orgId,
    () => labelingApi.agreement(orgId!, queueItemIds),
    {
      ...SHELL_QUERY,
      enabled: Boolean(orgId && queueItemIds.length > 0),
      retry: false,
    },
  );

  const currentPerItem = current
    ? agreementQuery.data?.per_item[current.id]
    : undefined;
  const annotationsCount =
    currentPerItem?.annotations_count ??
    (currentPerItem?.agreement != null ? 2 : 0);
  const agreementSoFar = currentPerItem?.agreement ?? null;

  const [label, setLabel] = useState<unknown>(null);
  const [confidence, setConfidence] = useState(0.8);
  const [notes, setNotes] = useState("");
  const [sessionLabeled, setSessionLabeled] = useState(0);
  const [sessionTimeSpentMs, setSessionTimeSpentMs] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const startedAtRef = useRef(Date.now());
  const itemStartRef = useRef<ItemStartSnapshot>({
    label: null,
    confidence: 0.8,
    notes: "",
  });
  const undoRef = useRef<UndoEntry | null>(null);

  useEffect(() => {
    setLabel(null);
    setConfidence(0.8);
    setNotes("");
    itemStartRef.current = { label: null, confidence: 0.8, notes: "" };
    startedAtRef.current = Date.now();
  }, [current?.id]);

  const advance = () => setQueue((prev) => prev.slice(1));

  const annotateMutation = useOrgMutation<unknown, AnnotateRequestBody>(
    (body) => labelingApi.annotate(orgId!, body),
    {
      onSuccess: (_data, variables) => {
        setCanUndo(true);
        setSessionLabeled((n) => n + 1);
        setSessionTimeSpentMs((ms) => ms + (variables.time_spent_ms ?? 0));
        pushToast({ title: "Annotation saved", tone: "ok" });
        advance();
      },
      onError: (err) => {
        undoRef.current = null;
        setCanUndo(false);
        pushToast({
          title: "Save failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        });
      },
    },
  );

  const undoMutation = useOrgMutation<unknown, AnnotateRequestBody>(
    (body) => labelingApi.annotate(orgId!, body),
    {
      onSuccess: () => {
        const undo = undoRef.current;
        if (!undo) return;
        setQueue((prev) => [undo.item, ...prev.filter((i) => i.id !== undo.item.id)]);
        undoRef.current = null;
        setCanUndo(false);
        setSessionLabeled((n) => Math.max(0, n - 1));
        setSessionTimeSpentMs((ms) => Math.max(0, ms - undo.timeSpentMs));
        pushToast({ title: "Annotation undone", tone: "ok" });
        void agreementQuery.refetch();
      },
      onError: (err) =>
        pushToast({
          title: "Undo failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        }),
    },
  );

  const skipMutation = useOrgMutation<unknown, string>(
    (itemId) => labelingApi.skip(orgId!, { item_id: itemId }),
    {
      onSuccess: () => advance(),
      onError: (err) =>
        pushToast({
          title: "Skip failed",
          body: err instanceof Error ? err.message : "Try again.",
          tone: "fail",
        }),
    },
  );

  const handleSubmit = () => {
    if (!current || annotateMutation.isPending) return;
    const timeSpentMs = Date.now() - startedAtRef.current;
    undoRef.current = {
      item: current,
      label: itemStartRef.current.label,
      confidence: itemStartRef.current.confidence,
      notes: itemStartRef.current.notes,
      timeSpentMs,
    };
    annotateMutation.mutate({
      item_id: current.id,
      label: label ?? "",
      confidence,
      notes: notes.trim() ? notes : null,
      time_spent_ms: timeSpentMs,
    });
  };

  const handleUndo = () => {
    const undo = undoRef.current;
    if (!undo || annotateMutation.isPending || undoMutation.isPending) return;
    undoMutation.mutate({
      item_id: undo.item.id,
      label: undo.label ?? "",
      confidence: undo.confidence,
      notes: undo.notes.trim() ? undo.notes : null,
      time_spent_ms: 0,
    });
  };

  const handleSkip = () => {
    if (!current || skipMutation.isPending) return;
    skipMutation.mutate(current.id);
  };

  const sessionAvgSeconds =
    sessionLabeled > 0 ? sessionTimeSpentMs / sessionLabeled / 1000 : 0;

  useEffect(() => {
    // Once the local lease is exhausted, pull the next batch.
    if (!popQuery.isLoading && queue.length === 0 && popQuery.data && popQuery.data.items.length > 0) {
      // Only refetch if we've actually consumed everything we were
      // given — avoids an infinite refetch loop when the org simply
      // has no more pending items.
      void popQuery.refetch();
    }
  }, [queue.length, popQuery]);

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Annotate"
        message="Select a workspace to annotate labeling items."
      />
    );
  }

  if (popQuery.isLoading) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Annotate" />
        <QueryLoadingPanel label="Leasing items…" />
      </div>
    );
  }

  if (popQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Annotate" />
        <QueryErrorPanel error={popQuery.error} onRetry={() => void popQuery.refetch()} />
      </div>
    );
  }

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Annotate"
        meta={
          <span className="type-meta">
            <Link href="/labeling" className="underline underline-offset-2">
              ← Labeling
            </Link>
          </span>
        }
      />
      {!current ? (
        <div className="flex min-h-0 flex-1 flex-col px-5 py-5">
          {sessionLabeled > 0 ? (
            <p className="type-meta mb-3 text-right">
              {formatAnnotateSessionStats(sessionLabeled, sessionAvgSeconds)}
            </p>
          ) : null}
          <EmptyState
            title="All caught up"
            body="No pending items are leased right now — check back once more items land in the pool."
          />
        </div>
      ) : (
        <AnnotateView
          item={current}
          queueLabel={paramQueue}
          label={label}
          onLabelChange={setLabel}
          confidence={confidence}
          onConfidenceChange={setConfidence}
          notes={notes}
          onNotesChange={setNotes}
          onSubmit={handleSubmit}
          onSkip={handleSkip}
          onUndo={handleUndo}
          submitting={annotateMutation.isPending}
          skipping={skipMutation.isPending}
          undoing={undoMutation.isPending}
          canUndo={canUndo}
          remaining={queue.length}
          sessionLabeled={sessionLabeled}
          sessionAvgSeconds={sessionAvgSeconds}
          annotationsCount={annotationsCount}
          agreementSoFar={agreementSoFar}
        />
      )}
    </div>
  );
}

export default function AnnotatePage() {
  return (
    <Suspense
      fallback={
        <div className="ds-page flex min-h-0 flex-1 items-center justify-center">
          <p className="type-meta">Loading annotate…</p>
        </div>
      }
    >
      <AnnotateInner />
    </Suspense>
  );
}
