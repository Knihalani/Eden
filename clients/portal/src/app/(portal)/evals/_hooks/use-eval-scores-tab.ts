"use client";

import { useState } from "react";
import {
  evalApi,
  type EvalFailureCluster,
  type EvalVersion,
} from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { useOrgMutation, useOrgQuery } from "@/hooks/use-api-query";
import { useToast } from "@/components/ui/toast";

export type FailureClusterRow = EvalFailureCluster & {
  issue_id?: string | null;
  trace_id?: string | null;
  sample_trace_ids?: string[];
};

export function useEvalScoresTab() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();

  const [judgeName, setJudgeName] = useState("");
  const [window, setWindow] = useState("24h");
  const [clusters, setClusters] = useState<FailureClusterRow[]>([]);
  const [clustersMeta, setClustersMeta] = useState<{
    total_failures: number;
    message?: string;
  } | null>(null);
  const [hasLoadedClusters, setHasLoadedClusters] = useState(false);

  const versionsQuery = useOrgQuery(
    queryKeys.evalVersions.list(orgId),
    orgId,
    async () => {
      const data = await evalApi.listVersions(orgId!);
      return data.versions ?? [];
    },
  );

  const clustersMutation = useOrgMutation(
    (vars: { judge_name: string; window?: string }) =>
      evalApi.failureClusters(orgId!, vars),
    {
      onSuccess: (data) => {
        setHasLoadedClusters(true);
        setClusters((data.clusters ?? []) as FailureClusterRow[]);
        setClustersMeta({
          total_failures: data.total_failures,
          message: data.message,
        });
      },
      onError: (e) => {
        setHasLoadedClusters(true);
        setClusters([]);
        toast.error(e.message || "Failed to load failure clusters");
      },
    },
  );

  const versions: EvalVersion[] = versionsQuery.data ?? [];

  function findClusters() {
    const name = judgeName.trim();
    if (!name) {
      toast.error("Judge name is required");
      return;
    }
    clustersMutation.mutate({
      judge_name: name,
      window: window.trim() || "24h",
    });
  }

  return {
    orgId,
    versions,
    versionsQuery,
    judgeName,
    setJudgeName,
    window,
    setWindow,
    clusters,
    clustersMeta,
    hasLoadedClusters,
    findClusters,
    clustersMutation,
  };
}
