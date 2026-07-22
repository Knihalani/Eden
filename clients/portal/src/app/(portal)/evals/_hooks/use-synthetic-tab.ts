"use client";

import { useMemo, useState } from "react";
import {
  datasetsApi,
  qaApi,
  type GenerateQAResponse,
  type QATriple,
  type Dataset,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";
import { useEvalsUrlState } from "./use-evals-url-state";

export function useSyntheticTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const { setState } = useEvalsUrlState();

  const [text, setText] = useState("");
  const [qaPerChunk, setQaPerChunk] = useState(3);
  const [lastResult, setLastResult] = useState<GenerateQAResponse | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingTriples, setPendingTriples] = useState<QATriple[]>([]);
  const [datasetId, setDatasetId] = useState("");

  // Run history is deferred (Phase J.5) — keep optional listRuns for message only.
  const runsQuery = useOrgQuery(
    queryKeys.synthetic.runs(orgId),
    orgId,
    async () => {
      const res = await qaApi.listRuns(orgId!);
      return {
        runs: res.runs || [],
        detail: res.detail,
        total: res.total,
      };
    },
  );

  const datasetsQuery = useOrgQuery(
    queryKeys.datasets.list(orgId),
    orgId,
    () => datasetsApi.list(orgId!),
  );

  const datasets: Dataset[] = datasetsQuery.data?.datasets ?? [];

  const generateMutation = useOrgMutation(
    (vars: { text: string; qa_per_chunk: number }) =>
      qaApi.generate(orgId!, {
        text: vars.text,
        qa_per_chunk: vars.qa_per_chunk,
      }),
    {
      onSuccess: (result) => {
        setLastResult(result);
        toast.success(
          `Generated ${result.triple_count} Q/A triple${result.triple_count === 1 ? "" : "s"}`,
        );
        void runsQuery.refetch();
      },
      onError: (e) => toast.error(e.message || "Failed to generate Q/A"),
    },
  );

  const addRowsMutation = useOrgMutation(
    async (vars: { dataset_id: string; triples: QATriple[] }) => {
      for (const triple of vars.triples) {
        await datasetsApi.addRow(orgId!, vars.dataset_id, {
          input: triple.question,
          expected_output: triple.answer,
          question: triple.question,
          answer: triple.answer,
          context: triple.context,
          source: "synthetic",
          triple_id: triple.id,
        });
      }
      return vars.dataset_id;
    },
    {
      invalidateKeys: [queryKeys.datasets.all],
      onSuccess: (id) => {
        toast.success(
          `Added ${pendingTriples.length} triple${pendingTriples.length === 1 ? "" : "s"} to dataset`,
        );
        setAddOpen(false);
        setPendingTriples([]);
        setDatasetId("");
        setState({ tab: "datasets", datasetId: id });
      },
      onError: (e) => toast.error(e.message || "Failed to add rows"),
    },
  );

  const triples: QATriple[] = lastResult?.triples ?? [];

  const historyDetail = useMemo(
    () =>
      runsQuery.data?.detail ||
      "Generation returns triples above. Saved run history is not available yet.",
    [runsQuery.data?.detail],
  );

  function generate() {
    if (!text.trim() || !orgId) return;
    generateMutation.mutate({
      text: text.trim(),
      qa_per_chunk: qaPerChunk,
    });
  }

  function openAddToDataset(selected: QATriple[]) {
    if (!selected.length) {
      toast.error("Select at least one triple");
      return;
    }
    setPendingTriples(selected);
    setAddOpen(true);
  }

  function confirmAddToDataset() {
    const target = datasetId.trim();
    if (!target) {
      toast.error("Pick a dataset");
      return;
    }
    addRowsMutation.mutate({ dataset_id: target, triples: pendingTriples });
  }

  return {
    orgId,
    text,
    setText,
    qaPerChunk,
    setQaPerChunk,
    lastResult,
    triples,
    generate,
    generateMutation,
    runsQuery,
    historyDetail,
    datasets,
    datasetsQuery,
    addOpen,
    setAddOpen,
    pendingTriples,
    datasetId,
    setDatasetId,
    openAddToDataset,
    confirmAddToDataset,
    addRowsMutation,
  };
}
