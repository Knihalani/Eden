"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { labelingQueuesApi, labelingApi, datasetsApi } from "@/lib/api";
import { errorFromCaught } from "@/lib/safe-error-message";
import { bindQueueHotkeys } from "./queue-hotkeys";

export type BoardItem = {
  id: string;
  prompt?: string;
  kanban_status?: string;
  tags?: string[];
  payload?: Record<string, unknown>;
};

export function useLabelingQueue() {
  const { id: queueId } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const embedded = useEmbeddedSurface();
  const router = useRouter();
  const toast = useToast();
  const [board, setBoard] = useState<Record<string, BoardItem[]>>({});
  const [schema, setSchema] = useState<Record<string, unknown>>({});
  const [iaa, setIaa] = useState<{ kappa: number; n: number; agreement_rate: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [showCheat, setShowCheat] = useState(true);
  const [exporting, setExporting] = useState(false);

  const labels = useMemo(() => {
    if (String(schema.type || "") === "pairwise") {
      return ["left", "right", "tie"];
    }
    const fromSchema = (schema.labels as string[] | undefined) || [];
    if (fromSchema.length) return fromSchema.slice(0, 9);
    return ["good", "bad", "unclear"];
  }, [schema]);

  const queue = useMemo(() => {
    const todo = board.todo || [];
    const progress = board.in_progress || [];
    return [...progress, ...todo];
  }, [board]);

  const active = queue.find((i) => i.id === activeId) || queue[0] || null;

  const load = useCallback(async () => {
    if (!currentOrg?.id || !queueId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [boardRes, queueRes, iaaRes] = await Promise.all([
        labelingQueuesApi.board(currentOrg.id, queueId),
        labelingQueuesApi.get(currentOrg.id, queueId),
        labelingQueuesApi.iaa(currentOrg.id, queueId).catch(() => null),
      ]);
      setBoard((boardRes.board || {}) as Record<string, BoardItem[]>);
      setSchema((queueRes.queue?.schema as Record<string, unknown>) || {});
      if (iaaRes?.iaa) setIaa(iaaRes.iaa);
      const items = [
        ...((boardRes.board?.in_progress as BoardItem[]) || []),
        ...((boardRes.board?.todo as BoardItem[]) || []),
      ];
      if (!activeId && items[0]) setActiveId(items[0].id);
    } catch (e) {
      setLoadError(errorFromCaught(e, "Failed to load board"));
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, queueId, activeId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on org/queue change only
  }, [currentOrg?.id, queueId]);

  const applyLabel = useCallback(
    async (label: string) => {
      if (!currentOrg?.id || !active || !queueId) return;
      try {
        await labelingApi.annotate(currentOrg.id, {
          item_id: active.id,
          label,
          notes: notes.trim() || undefined,
        });
        await labelingQueuesApi.move(currentOrg.id, queueId, {
          item_id: active.id,
          status: "done",
        });
        toast.success(`Labeled ${label}`);
        setNotes("");
        const next = queue.find((i) => i.id !== active.id);
        setActiveId(next?.id ?? null);
        await load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Annotate failed");
      }
    },
    [active, currentOrg?.id, load, notes, queue, queueId, toast],
  );

  const skip = useCallback(async () => {
    if (!currentOrg?.id || !active || !queueId) return;
    try {
      await labelingApi.skip(currentOrg.id, { item_id: active.id });
      await labelingQueuesApi.move(currentOrg.id, queueId, {
        item_id: active.id,
        status: "skipped",
      });
      toast.success("Skipped");
      const next = queue.find((i) => i.id !== active.id);
      setActiveId(next?.id ?? null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Skip failed");
    }
  }, [active, currentOrg?.id, load, queue, queueId, toast]);

  useEffect(() => {
    return bindQueueHotkeys({
      labels,
      onApplyLabel: (l) => void applyLabel(l),
      onSkip: () => void skip(),
      onToggleCheat: () => setShowCheat((v) => !v),
    });
  }, [applyLabel, labels, skip]);

  const exportDataset = async () => {
    if (!currentOrg?.id || !queueId) return;
    let target = datasetId.trim();
    setExporting(true);
    try {
      if (!target) {
        const created = await datasetsApi.create(currentOrg.id, {
          name: `Labels · ${queueId.slice(0, 8)}`,
          description: "Exported from labeling queue",
        });
        target = created.id;
      }
      await labelingQueuesApi.pushToDataset(currentOrg.id, queueId, { dataset_id: target });
      toast.success("Pushed done items to dataset");
      router.push(`/datasets/${target}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const transcript = String(
    active?.payload?.transcript || active?.payload?.messages || active?.prompt || "",
  );

  return {
    currentOrg,
    embedded,
    queueId,
    board,
    schema,
    iaa,
    loading,
    loadError,
    activeId,
    setActiveId,
    notes,
    setNotes,
    datasetId,
    setDatasetId,
    showCheat,
    setShowCheat,
    exporting,
    labels,
    queue,
    active,
    load,
    applyLabel,
    skip,
    exportDataset,
    transcript,
  };
}
