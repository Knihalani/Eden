"use client";

import { useCallback, useMemo, useState } from "react";
import {
  labelingApi,
  labelingQueuesApi,
  datasetsApi,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";
import { useEvalsUrlState } from "./use-evals-url-state";

export type LabelingQueueRow = {
  id: string;
  name?: string;
  description?: string;
  status?: string;
  created_at?: string;
};

export type BoardItem = {
  id: string;
  prompt?: string;
  kanban_status?: string;
  tags?: string[];
  payload?: Record<string, unknown>;
};

function asQueueRows(raw: Array<Record<string, unknown>>): LabelingQueueRow[] {
  return raw.map((q) => ({
    id: String(q.id ?? ""),
    name: typeof q.name === "string" ? q.name : undefined,
    description: typeof q.description === "string" ? q.description : undefined,
    status: typeof q.status === "string" ? q.status : undefined,
    created_at: typeof q.created_at === "string" ? q.created_at : undefined,
  })).filter((q) => q.id);
}

function asBoardItems(raw: unknown): BoardItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    return {
      id: String(row.id ?? ""),
      prompt: typeof row.prompt === "string" ? row.prompt : undefined,
      kanban_status:
        typeof row.kanban_status === "string" ? row.kanban_status : undefined,
      tags: Array.isArray(row.tags)
        ? row.tags.filter((t): t is string => typeof t === "string")
        : undefined,
      payload:
        row.payload && typeof row.payload === "object"
          ? (row.payload as Record<string, unknown>)
          : undefined,
    };
  }).filter((i) => i.id);
}

export function useLabelingTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const { state, setState } = useEvalsUrlState();
  const queueId = state.queueId ?? null;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [pushDatasetId, setPushDatasetId] = useState("");
  const [pushOpen, setPushOpen] = useState(false);

  const queuesQuery = useOrgQuery(
    queryKeys.labelingQueues.list(orgId),
    orgId,
    async () => {
      const res = await labelingQueuesApi.list(orgId!);
      return asQueueRows((res.queues || []) as Array<Record<string, unknown>>);
    },
  );

  const boardQuery = useOrgQuery(
    queryKeys.labelingQueues.board(orgId, queueId),
    orgId,
    async () => {
      const [boardRes, queueRes] = await Promise.all([
        labelingQueuesApi.board(orgId!, queueId!),
        labelingQueuesApi.get(orgId!, queueId!),
      ]);
      return {
        board: (boardRes.board || {}) as Record<string, unknown>,
        schema: (queueRes.queue?.schema as Record<string, unknown>) || {},
        queue: queueRes.queue as Record<string, unknown> | undefined,
      };
    },
    { enabled: Boolean(queueId) },
  );

  const boardColumns = useMemo(() => {
    const board = boardQuery.data?.board ?? {};
    const pending = [
      ...asBoardItems(board.todo),
      ...asBoardItems(board.in_progress),
      ...asBoardItems(board.pending),
    ];
    const labeled = [
      ...asBoardItems(board.done),
      ...asBoardItems(board.labeled),
    ];
    const skipped = asBoardItems(board.skipped);
    return { pending, labeled, skipped };
  }, [boardQuery.data?.board]);

  const labels = useMemo(() => {
    const schema = boardQuery.data?.schema ?? {};
    if (String(schema.type || "") === "pairwise") {
      return ["left", "right", "tie"];
    }
    const fromSchema = (schema.labels as string[] | undefined) || [];
    if (fromSchema.length) return fromSchema.slice(0, 9);
    return ["good", "bad", "unclear"];
  }, [boardQuery.data?.schema]);

  const workQueue = useMemo(
    () => boardColumns.pending,
    [boardColumns.pending],
  );

  const active =
    workQueue.find((i) => i.id === activeId) || workQueue[0] || null;

  const transcript = String(
    active?.payload?.transcript ||
      active?.payload?.messages ||
      active?.prompt ||
      "",
  );

  const annotateMutation = useOrgMutation(
    async (vars: { item_id: string; label: string; notes?: string }) => {
      await labelingApi.annotate(orgId!, vars);
      await labelingQueuesApi.move(orgId!, queueId!, {
        item_id: vars.item_id,
        status: "done",
      });
    },
    {
      invalidateKeys: [
        queryKeys.labelingQueues.board(orgId, queueId),
        queryKeys.labelingQueues.list(orgId),
      ],
      onSuccess: (_data, vars) => {
        toast.success(`Labeled ${vars.label}`);
        setNotes("");
        const next = workQueue.find((i) => i.id !== vars.item_id);
        setActiveId(next?.id ?? null);
      },
      onError: (e) => toast.error(e.message || "Annotate failed"),
    },
  );

  const skipMutation = useOrgMutation(
    async (vars: { item_id: string }) => {
      await labelingApi.skip(orgId!, { item_id: vars.item_id });
      await labelingQueuesApi.move(orgId!, queueId!, {
        item_id: vars.item_id,
        status: "skipped",
      });
    },
    {
      invalidateKeys: [
        queryKeys.labelingQueues.board(orgId, queueId),
        queryKeys.labelingQueues.list(orgId),
      ],
      onSuccess: (_data, vars) => {
        toast.success("Skipped");
        const next = workQueue.find((i) => i.id !== vars.item_id);
        setActiveId(next?.id ?? null);
      },
      onError: (e) => toast.error(e.message || "Skip failed"),
    },
  );

  const moveMutation = useOrgMutation(
    (vars: { item_id: string; status: string }) =>
      labelingQueuesApi.move(orgId!, queueId!, vars),
    {
      invalidateKeys: [queryKeys.labelingQueues.board(orgId, queueId)],
      onError: (e) => toast.error(e.message || "Move failed"),
    },
  );

  const pushMutation = useOrgMutation(
    async (vars: { dataset_id?: string }) => {
      let target = (vars.dataset_id || "").trim();
      if (!target) {
        const created = await datasetsApi.create(orgId!, {
          name: `Labels · ${(queueId || "").slice(0, 8)}`,
          description: "Exported from labeling queue",
        });
        target = created.id;
      }
      await labelingQueuesApi.pushToDataset(orgId!, queueId!, {
        dataset_id: target,
      });
      return target;
    },
    {
      invalidateKeys: [
        queryKeys.labelingQueues.board(orgId, queueId),
        queryKeys.datasets.all,
      ],
      onSuccess: (target) => {
        toast.success("Pushed done items to dataset");
        setPushOpen(false);
        setPushDatasetId("");
        setState({ tab: "datasets", datasetId: target, queueId: undefined });
      },
      onError: (e) => toast.error(e.message || "Push to dataset failed"),
    },
  );

  const applyLabel = useCallback(
    (label: string) => {
      if (!active || !orgId || !queueId) return;
      annotateMutation.mutate({
        item_id: active.id,
        label,
        notes: notes.trim() || undefined,
      });
    },
    [active, annotateMutation, notes, orgId, queueId],
  );

  const skipActive = useCallback(() => {
    if (!active || !orgId || !queueId) return;
    skipMutation.mutate({ item_id: active.id });
  }, [active, orgId, queueId, skipMutation]);

  function openQueue(id: string) {
    setActiveId(null);
    setState({ tab: "labeling", queueId: id });
  }

  function closeQueue() {
    setActiveId(null);
    setState({ queueId: undefined });
  }

  return {
    orgId,
    queueId,
    queues: queuesQuery.data ?? [],
    queuesQuery,
    boardQuery,
    boardColumns,
    labels,
    workQueue,
    active,
    activeId,
    setActiveId,
    notes,
    setNotes,
    transcript,
    applyLabel,
    skipActive,
    moveMutation,
    annotateMutation,
    skipMutation,
    pushMutation,
    pushOpen,
    setPushOpen,
    pushDatasetId,
    setPushDatasetId,
    openQueue,
    closeQueue,
  };
}
