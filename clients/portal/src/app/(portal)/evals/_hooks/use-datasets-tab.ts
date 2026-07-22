"use client";

import { useEffect, useMemo, useRef } from "react";
import { datasetsApi, type Dataset } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";
import { useEvalsUrlState } from "./use-evals-url-state";

export type DatasetListRow = Dataset & {
  updated_at?: string;
  agent_id?: string;
  source?: string;
};

export function useDatasetsTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const { state, setState, clearSelection } = useEvalsUrlState();

  const listQuery = useOrgQuery(
    queryKeys.datasets.list(orgId),
    orgId,
    () => datasetsApi.list(orgId!),
  );

  const datasets: DatasetListRow[] = useMemo(
    () => (listQuery.data?.datasets ?? []) as DatasetListRow[],
    [listQuery.data],
  );

  const q = state.q ?? "";
  const agentId = state.agentId;

  const filtered = useMemo(() => {
    let rows = datasets;
    if (agentId) {
      rows = rows.filter((d) => d.agent_id === agentId);
    }
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      rows = rows.filter(
        (d) =>
          d.name.toLowerCase().includes(needle) ||
          (d.description ?? "").toLowerCase().includes(needle) ||
          d.id.toLowerCase().includes(needle),
      );
    }
    return rows;
  }, [datasets, agentId, q]);

  const filtersActive = Boolean(q.trim() || agentId);
  const datasetId = state.datasetId;

  const selected =
    datasetId != null
      ? (filtered.find((d) => d.id === datasetId) ??
        datasets.find((d) => d.id === datasetId) ??
        null)
      : null;

  const selectedIndex = selected
    ? filtered.findIndex((d) => d.id === selected.id)
    : -1;

  const promoteMutation = useOrgMutation(
    (vars: { trace_id: string; dataset_name?: string }) =>
      datasetsApi.promoteFromTrace(orgId!, vars),
    {
      invalidateKeys: [queryKeys.datasets.all],
      onSuccess: (res) => {
        const id = res.data?.dataset_id;
        toast.success("Trace promoted into dataset");
        setState({
          traceId: undefined,
          spanId: undefined,
          datasetId: id,
          tab: "datasets",
        });
      },
      onError: (e) => {
        toast.error(e.message || "Promote failed");
        setState({ traceId: undefined, spanId: undefined });
      },
    },
  );

  const promoteTraceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state.traceId || !orgId) return;
    if (promoteMutation.isPending) return;
    if (promoteTraceRef.current === state.traceId) return;
    promoteTraceRef.current = state.traceId;
    promoteMutation.mutate({
      trace_id: state.traceId,
      dataset_name: `From trace ${state.traceId.slice(0, 8)}`,
    });
  }, [state.traceId, orgId, promoteMutation]);

  const createMutation = useOrgMutation(
    (vars: { name: string; description?: string }) =>
      datasetsApi.create(orgId!, vars),
    {
      invalidateKeys: [queryKeys.datasets.all],
      onSuccess: (ds) => {
        toast.success("Dataset created");
        setState({ datasetId: ds.id, tab: "datasets" });
      },
      onError: (e) => {
        toast.error(e.message || "Create failed");
      },
    },
  );

  function selectDataset(id: string) {
    setState({ datasetId: id, tab: "datasets" });
  }

  function clearDatasetSelection() {
    clearSelection();
  }

  function selectPrev() {
    if (selectedIndex <= 0) return;
    const row = filtered[selectedIndex - 1];
    if (row) selectDataset(row.id);
  }

  function selectNext() {
    if (selectedIndex < 0 || selectedIndex >= filtered.length - 1) return;
    const row = filtered[selectedIndex + 1];
    if (row) selectDataset(row.id);
  }

  function setSearch(value: string) {
    setState({ q: value || undefined });
  }

  function clearFilters() {
    setState({ q: undefined, agentId: undefined });
  }

  return {
    orgId,
    state,
    setState,
    listQuery,
    datasets,
    filtered,
    filtersActive,
    datasetId,
    selected,
    selectedIndex,
    selectDataset,
    clearDatasetSelection,
    selectPrev,
    selectNext,
    setSearch,
    clearFilters,
    createMutation,
    promoteMutation,
  };
}

export type DatasetsTabState = ReturnType<typeof useDatasetsTab>;
