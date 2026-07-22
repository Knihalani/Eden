"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { datasetsApi, type Dataset } from "@/lib/api";
import { useDensity, useResourceUrlState } from "@/components/portal-os";
import { usePagePerf } from "@/lib/perf";
import { useListKeyboardNav } from "@/hooks/use-list-keyboard-nav";
import { parsePromoteTraceIds } from "@/lib/portal-cross-links";

export function useDatasetsPage() {
  const { currentOrg } = useOrg();
  usePagePerf("/datasets");
  const toast = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const embedded = false;
  const density = useDensity();
  const { state: urlState, setState: setUrlState } = useResourceUrlState();
  const datasetId = urlState.datasetId;
  const filter = urlState.q ?? "";
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await datasetsApi.list(currentOrg.id);
      setDatasets(res.datasets || []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load datasets";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    load();
  }, [load]);

  // E1 / M7 — single `promote_trace` or batch `promote_traces` (N× promoteFromTrace).
  useEffect(() => {
    const traceIds = parsePromoteTraceIds(searchParams);
    if (traceIds.length === 0 || !currentOrg?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        let lastDatasetId: string | undefined;
        let ok = 0;
        for (const traceId of traceIds) {
          if (cancelled) return;
          const res = await datasetsApi.promoteFromTrace(currentOrg.id, {
            trace_id: traceId,
            dataset_id: lastDatasetId,
            dataset_name: lastDatasetId
              ? undefined
              : `From traces ${traceIds[0]!.slice(0, 8)}`,
          });
          lastDatasetId = res.data?.dataset_id ?? lastDatasetId;
          ok += 1;
        }
        if (cancelled) return;
        toast.success(
          ok === 1
            ? "Trace promoted into dataset"
            : `${ok} traces promoted into dataset`,
        );
        if (lastDatasetId) {
          router.replace(
            `/evals?tab=datasets&datasetId=${encodeURIComponent(lastDatasetId)}`,
          );
        } else {
          router.replace("/evals?tab=datasets");
          await load();
        }
      } catch (e) {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : "Promote failed");
          router.replace("/evals?tab=datasets");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams, currentOrg?.id, load, router, toast]);

  const createDataset = async () => {
    if (!newName.trim() || !currentOrg?.id) return;
    setCreating(true);
    try {
      const ds = await datasetsApi.create(currentOrg.id, { name: newName.trim() });
      toast.success("Dataset created");
      setNewName("");
      await load();
      router.push(
        `/evals?tab=datasets&datasetId=${encodeURIComponent(ds.id)}`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const clearFilter = () => setUrlState({ q: undefined });

  const filtered = datasets.filter((d) =>
    d.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const filterActive = Boolean(filter.trim());
  const filterMiss =
    filterActive && !loading && !error && datasets.length > 0 && filtered.length === 0;

  const selected = datasetId
    ? filtered.find((d) => d.id === datasetId) ??
      datasets.find((d) => d.id === datasetId) ??
      null
    : null;
  const selectedIndex = selected
    ? filtered.findIndex((d) => d.id === selected.id)
    : -1;

  const selectDataset = (id: string) => setUrlState({ datasetId: id });
  const clearSelection = () => setUrlState({ datasetId: undefined });
  const selectPrev =
    selectedIndex > 0
      ? () => setUrlState({ datasetId: filtered[selectedIndex - 1]!.id })
      : undefined;
  const selectNext =
    selectedIndex >= 0 && selectedIndex < filtered.length - 1
      ? () => setUrlState({ datasetId: filtered[selectedIndex + 1]!.id })
      : undefined;

  useListKeyboardNav(
    filtered.length,
    selectedIndex >= 0 ? selectedIndex : 0,
    (idx) => {
      const row = filtered[idx];
      if (row) setUrlState({ datasetId: row.id });
    },
    filtered.length > 0,
  );

  return {
    currentOrg,
    embedded,
    density,
    datasetId,
    filter,
    nameInputRef,
    datasets,
    loading,
    error,
    newName,
    setNewName,
    creating,
    load,
    createDataset,
    clearFilter,
    filtered,
    filterActive,
    filterMiss,
    selected,
    selectDataset,
    clearSelection,
    selectPrev,
    selectNext,
  };
}

export type DatasetsPageState = ReturnType<typeof useDatasetsPage>;
