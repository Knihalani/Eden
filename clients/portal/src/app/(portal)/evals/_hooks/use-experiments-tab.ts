"use client";

import { useMemo } from "react";
import { offlineExperimentsApi } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import {
  gradeFromDatapoint,
  sortDatapointsFailingFirst,
  type ComparisonGrade,
  type Datapoint,
} from "@/lib/compare-grades";
import type { EvalsCompareLayout } from "@/lib/evals-url";
import { useEvalsUrlState } from "./use-evals-url-state";

export type ExperimentRow = {
  id: string;
  name: string;
  dataset_id: string;
  status: string;
  created_at: string;
  avg_score?: number | null;
  cost_usd?: number | null;
  latency_ms?: number | null;
};

function mapExperimentRow(raw: Record<string, unknown>): ExperimentRow {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? "Untitled"),
    dataset_id: String(raw.dataset_id ?? ""),
    status: String(raw.status ?? "unknown"),
    created_at: String(raw.created_at ?? ""),
    avg_score:
      typeof raw.avg_score === "number"
        ? raw.avg_score
        : typeof raw.score === "number"
          ? raw.score
          : null,
    cost_usd: typeof raw.cost_usd === "number" ? raw.cost_usd : null,
    latency_ms: typeof raw.latency_ms === "number" ? raw.latency_ms : null,
  };
}

function mapDatapoint(raw: Record<string, unknown>): Datapoint {
  return {
    row_id: raw.row_id != null ? String(raw.row_id) : undefined,
    grade: raw.grade != null ? String(raw.grade) : undefined,
    score_delta:
      typeof raw.score_delta === "number" ? raw.score_delta : undefined,
    control_score:
      typeof raw.control_score === "number" ? raw.control_score : undefined,
    treatment_score:
      typeof raw.treatment_score === "number" ? raw.treatment_score : undefined,
    control_output: raw.control_output as Datapoint["control_output"],
    treatment_output: raw.treatment_output as Datapoint["treatment_output"],
    expected_output: raw.expected_output as Datapoint["expected_output"],
    input_data: raw.input_data as Datapoint["input_data"],
    trace_id: raw.trace_id != null ? String(raw.trace_id) : undefined,
  };
}

export function useExperimentsTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { state, setState, clearSelection } = useEvalsUrlState();

  const experimentId = state.experimentId;
  const compareId = state.compareId ?? experimentId;
  const baselineId = state.baselineId;
  const layout: EvalsCompareLayout = state.layout ?? "summary";
  const diffOn = state.diff === "1";
  const gradeFilter = state.grade;

  const listQuery = useOrgQuery(
    queryKeys.offlineExperiments.list(orgId),
    orgId,
    () => offlineExperimentsApi.list(orgId!),
  );

  const experiments: ExperimentRow[] = useMemo(
    () =>
      (listQuery.data?.experiments ?? []).map((r) =>
        mapExperimentRow(r as Record<string, unknown>),
      ),
    [listQuery.data],
  );

  const q = state.q ?? "";

  const filtered = useMemo(() => {
    if (!q.trim()) return experiments;
    const needle = q.trim().toLowerCase();
    return experiments.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.id.toLowerCase().includes(needle) ||
        e.dataset_id.toLowerCase().includes(needle) ||
        e.status.toLowerCase().includes(needle),
    );
  }, [experiments, q]);

  const filtersActive = Boolean(q.trim() || gradeFilter);

  const selected =
    experimentId != null
      ? (filtered.find((e) => e.id === experimentId) ??
        experiments.find((e) => e.id === experimentId) ??
        null)
      : null;

  const selectedIndex = selected
    ? filtered.findIndex((e) => e.id === selected.id)
    : -1;

  const compareQuery = useOrgQuery(
    queryKeys.offlineExperiments.compare(
      orgId,
      compareId ?? "",
      baselineId ?? "",
    ),
    orgId,
    () => offlineExperimentsApi.compare(orgId!, compareId!, baselineId!),
    { enabled: Boolean(compareId) },
  );

  const summary = (compareQuery.data?.compare?.summary ?? null) as Record<
    string,
    number
  > | null;

  const datapoints: Datapoint[] = useMemo(() => {
    const raw = compareQuery.data?.compare?.datapoints ?? [];
    return raw.map((r) => mapDatapoint(r as Record<string, unknown>));
  }, [compareQuery.data]);

  const gradedDatapoints = useMemo(() => {
    let rows = sortDatapointsFailingFirst(datapoints);
    if (gradeFilter) {
      rows = rows.filter(
        (dp) => gradeFromDatapoint(dp) === (gradeFilter as ComparisonGrade),
      );
    }
    return rows;
  }, [datapoints, gradeFilter]);

  const baselineCandidates = useMemo(
    () =>
      experiments.filter(
        (e) =>
          e.id !== compareId &&
          (!selected?.dataset_id || e.dataset_id === selected.dataset_id),
      ),
    [experiments, compareId, selected?.dataset_id],
  );

  const baselineRow =
    baselineId != null
      ? (experiments.find((e) => e.id === baselineId) ?? null)
      : null;

  const compareRow =
    compareId != null
      ? (experiments.find((e) => e.id === compareId) ?? selected)
      : null;

  function selectExperiment(id: string) {
    setState({ experimentId: id, tab: "experiments", compareId: id });
  }

  function clearExperimentSelection() {
    clearSelection();
  }

  function selectPrev() {
    if (selectedIndex <= 0) return;
    const row = filtered[selectedIndex - 1];
    if (row) selectExperiment(row.id);
  }

  function selectNext() {
    if (selectedIndex < 0 || selectedIndex >= filtered.length - 1) return;
    const row = filtered[selectedIndex + 1];
    if (row) selectExperiment(row.id);
  }

  function setBaseline(id: string | undefined) {
    setState({ baselineId: id });
  }

  function setCompare(id: string | undefined) {
    setState({
      compareId: id,
      experimentId: id ?? state.experimentId,
    });
  }

  function setLayout(next: EvalsCompareLayout) {
    setState({ layout: next });
  }

  function setDiff(on: boolean) {
    setState({ diff: on ? "1" : "0" });
  }

  function setGrade(grade: ComparisonGrade | undefined) {
    setState({ grade });
  }

  function setSearch(value: string) {
    setState({ q: value || undefined });
  }

  function clearFilters() {
    setState({ q: undefined, grade: undefined });
  }

  return {
    orgId,
    state,
    setState,
    listQuery,
    experiments,
    filtered,
    filtersActive,
    experimentId,
    compareId,
    baselineId,
    layout,
    diffOn,
    gradeFilter,
    selected,
    selectedIndex,
    selectExperiment,
    clearExperimentSelection,
    selectPrev,
    selectNext,
    compareQuery,
    summary,
    datapoints,
    gradedDatapoints,
    baselineCandidates,
    baselineRow,
    compareRow,
    setBaseline,
    setCompare,
    setLayout,
    setDiff,
    setGrade,
    setSearch,
    clearFilters,
  };
}

export type ExperimentsTabState = ReturnType<typeof useExperimentsTab>;
