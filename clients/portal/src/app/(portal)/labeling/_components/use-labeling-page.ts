"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import {
  labelingApi,
  labelingQueuesApi,
  datasetsApi,
  type LabelingItem,
} from "@/lib/api";

export const WAVE_E5_LABELING_COMPLETED = true;

export type QueueRow = {
  id: string;
  name?: string;
  description?: string;
  status?: string;
  created_at?: string;
};

export function useLabelingPage() {
  const { currentOrg } = useOrg();
  const embedded = useEmbeddedSurface();
  const orgId = currentOrg?.id ?? null;
  const router = useRouter();
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [reviewItem, setReviewItem] = useState<LabelingItem | null>(null);
  const [label, setLabel] = useState("approved");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [creatingQueue, setCreatingQueue] = useState(false);
  const [pushingQueueId, setPushingQueueId] = useState<string | null>(null);

  const itemsQuery = useOrgQuery(
    queryKeys.labeling.items(orgId),
    orgId,
    async () => {
      const { fetchApi } = await import("@/lib/api/core");
      const res = await fetchApi<{ items: LabelingItem[]; total: number }>(
        `/orgs/${orgId}/labeling/items?limit=100`,
        { headers: { "X-Org-Id": orgId! } },
      );
      return res.items || [];
    },
  );
  const items = itemsQuery.data ?? [];
  const loading = itemsQuery.isLoading;
  const error = itemsQuery.error?.message ?? null;
  const load = () => void itemsQuery.refetch();

  const queuesQuery = useOrgQuery(
    queryKeys.labeling.queues(orgId),
    orgId,
    async () => {
      const res = await labelingQueuesApi.list(orgId!);
      return (res.queues || []) as QueueRow[];
    },
  );
  const queues = queuesQuery.data ?? [];
  const queuesError = queuesQuery.error?.message ?? null;
  const queuesLoading = queuesQuery.isLoading;

  const openReview = (item: LabelingItem) => {
    setReviewItem(item);
    setLabel("approved");
    setNotes("");
  };

  const closeReview = () => {
    if (submitting) return;
    setReviewItem(null);
  };

  const handleAnnotate = async (nextLabel: string) => {
    if (!currentOrg?.id || !reviewItem) return;
    setSubmitting(true);
    try {
      await labelingApi.annotate(currentOrg.id, {
        item_id: reviewItem.id,
        label: nextLabel,
        notes: notes.trim() || undefined,
      });
      toast.success(nextLabel === "approved" ? "Item approved" : "Annotation saved");
      setReviewItem(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to submit annotation");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = async (item: LabelingItem) => {
    if (!currentOrg?.id) return;
    setSubmitting(true);
    try {
      await labelingApi.skip(currentOrg.id, { item_id: item.id });
      toast.success("Item skipped");
      if (reviewItem?.id === item.id) setReviewItem(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to skip item");
    } finally {
      setSubmitting(false);
    }
  };

  const seedItem = async () => {
    const prompt = window.prompt("Seed item prompt:");
    if (!prompt?.trim() || !currentOrg?.id) return;
    try {
      await labelingApi.seedItem(currentOrg.id, { prompt: prompt.trim() });
      toast.success("Item seeded");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to seed item");
    }
  };

  const createQueue = async () => {
    if (!currentOrg?.id) return;
    const name = window.prompt("New labeling queue name:");
    if (!name?.trim()) return;
    setCreatingQueue(true);
    try {
      const res = await labelingQueuesApi.create(currentOrg.id, { name: name.trim() });
      const qid = String(res.queue?.id || "");
      toast.success("Queue created");
      void queuesQuery.refetch();
      if (qid) router.push(`/labeling/queues/${qid}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create queue");
    } finally {
      setCreatingQueue(false);
    }
  };

  const pushQueueToDataset = async (queue: QueueRow) => {
    if (!currentOrg?.id) return;
    const entered = window.prompt(
      "Dataset id (leave blank to create a new dataset):",
      "",
    );
    if (entered === null) return;
    setPushingQueueId(queue.id);
    try {
      let target = entered.trim();
      if (!target) {
        const created = await datasetsApi.create(currentOrg.id, {
          name: `Labels · ${queue.name || queue.id.slice(0, 8)}`,
          description: "Pushed from labeling queue",
        });
        target = created.id;
      }
      await labelingQueuesApi.pushToDataset(currentOrg.id, queue.id, {
        dataset_id: target,
      });
      toast.success("Pushed done items to dataset");
      router.push(`/datasets/${target}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Push to dataset failed");
    } finally {
      setPushingQueueId(null);
    }
  };

  const filtered = items.filter((i) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    const tags = i.tags ?? [];
    return (
      (i.prompt ?? "").toLowerCase().includes(q) ||
      tags.some((t) => t.toLowerCase().includes(q))
    );
  });
  const filterActive = Boolean(filter.trim());
  const filterMiss =
    filterActive && !loading && !error && items.length > 0 && filtered.length === 0;

  return {
    currentOrg,
    embedded,
    filter,
    setFilter,
    reviewItem,
    label,
    setLabel,
    notes,
    setNotes,
    submitting,
    creatingQueue,
    pushingQueueId,
    items,
    loading,
    error,
    load,
    queues,
    queuesError,
    queuesLoading,
    queuesQuery,
    openReview,
    closeReview,
    handleAnnotate,
    handleSkip,
    seedItem,
    createQueue,
    pushQueueToDataset,
    filtered,
    filterActive,
    filterMiss,
  };
}
