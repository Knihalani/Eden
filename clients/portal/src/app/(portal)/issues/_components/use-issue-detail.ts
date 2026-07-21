"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { agentIssuesApi, ApiError } from "@/lib/api";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useToast } from "@/components/ui/toast";
import { preserveFromSearchParams } from "@/lib/portal-cross-links";
import type { IssueDetailTab } from "./issue-detail-header";

export function useIssueDetail(issueId: string | undefined) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const searchParams = useSearchParams();
  const toast = useToast();
  const preserve = useMemo(() => preserveFromSearchParams(searchParams), [searchParams]);

  const [tab, setTab] = useState<IssueDetailTab>("overview");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const qTab = searchParams?.get("tab");
    if (qTab === "handoff" || searchParams?.get("handoff") === "coding-agent") {
      setTab("handoff");
    }
  }, [searchParams]);

  const issueQuery = useOrgQuery(
    queryKeys.issues.detail(orgId, issueId),
    orgId,
    () => agentIssuesApi.get(orgId!, issueId!),
    { enabled: Boolean(orgId) && Boolean(issueId) },
  );
  const issue = issueQuery.data?.data?.issue ?? null;
  const loading = issueQuery.isLoading;
  const error = issueQuery.error?.message ?? null;
  const isNotFound =
    issueQuery.error instanceof ApiError && issueQuery.error.status === 404;

  const stumblesQuery = useOrgQuery(
    queryKeys.issues.stumbles(orgId, { fingerprint: issue?.fingerprint, limit: 20 }),
    orgId,
    () =>
      agentIssuesApi
        .stumbles(orgId!, { fingerprint: issue!.fingerprint, limit: 20 })
        .then((res) => res.data?.stumbles ?? []),
    { enabled: Boolean(orgId) && Boolean(issue?.fingerprint) },
  );
  const stumbles = stumblesQuery.data ?? [];
  const stumblesError = stumblesQuery.error?.message ?? null;

  const experimentsQuery = useOrgQuery(
    queryKeys.issues.experiments(orgId, issueId),
    orgId,
    () =>
      agentIssuesApi
        .listExperiments(orgId!, issueId!)
        .then((res) => res.data?.experiments ?? []),
    { enabled: Boolean(orgId) && Boolean(issueId) },
  );
  const experiments = experimentsQuery.data ?? [];
  const experimentsError = experimentsQuery.error?.message ?? null;

  const regressionQuery = useOrgQuery(
    queryKeys.issues.regressionCases(orgId, issueId),
    orgId,
    () =>
      agentIssuesApi
        .listRegressionCases(orgId!, issueId!)
        .then((res) => (res.data?.cases as Record<string, unknown>[]) ?? []),
    { enabled: Boolean(orgId) && Boolean(issueId) },
  );
  const regressionCases = regressionQuery.data ?? [];
  const regressionError = regressionQuery.error?.message ?? null;

  const invalidateIssue = [
    queryKeys.issues.detail(orgId, issueId),
    queryKeys.issues.list(orgId),
    queryKeys.issues.experiments(orgId, issueId),
    queryKeys.issues.regressionCases(orgId, issueId),
  ];

  const triageMutation = useOrgMutation(
    () => agentIssuesApi.triage(orgId!, issueId!, { force: true }),
    { invalidateKeys: invalidateIssue },
  );
  const resolveMutation = useOrgMutation(
    (status: "resolved" | "ignored") => agentIssuesApi.resolve(orgId!, issueId!, { status }),
    { invalidateKeys: invalidateIssue },
  );
  const createExperimentMutation = useOrgMutation(
    () =>
      agentIssuesApi.createExperiment(orgId!, issueId!, {
        control_variant: "production",
        treatment_variant: "candidate",
      }),
    { invalidateKeys: invalidateIssue },
  );

  const onTriage = async () => {
    if (!orgId || !issueId) return;
    setBusy("triage");
    try {
      await triageMutation.mutateAsync();
      toast.success("Triage complete");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Triage failed");
    } finally {
      setBusy(null);
    }
  };

  const onResolve = async (status: "resolved" | "ignored") => {
    if (!orgId || !issueId) return;
    setBusy(status);
    try {
      await resolveMutation.mutateAsync(status);
      toast.success(`Issue ${status}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(null);
    }
  };

  const onExportFixture = async () => {
    if (!orgId || !issueId) return;
    setBusy("export");
    try {
      const res = await agentIssuesApi.exportFixture(orgId, issueId);
      const fixture = res.data?.fixture ?? res.data;
      const blob = new Blob([JSON.stringify(fixture, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `eden-fixture-${issueId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Fixture exported");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(null);
    }
  };

  const onSaveRegression = async () => {
    if (!orgId || !issueId) return;
    setBusy("regression");
    try {
      await agentIssuesApi.createRegressionCases(orgId, issueId, { auto: true });
      toast.success("Regression case saved to permanent memory");
      void issueQuery.refetch();
      void regressionQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Regression save failed");
    } finally {
      setBusy(null);
    }
  };

  const onCreateExperiment = async () => {
    if (!orgId || !issueId) return;
    setBusy("experiment");
    try {
      await createExperimentMutation.mutateAsync();
      toast.success("Experiment started");
      setTab("experiment");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Experiment failed");
    } finally {
      setBusy(null);
    }
  };

  const onExperimentReport = async (linkId: string) => {
    if (!orgId || !issueId) return;
    setBusy(`report-${linkId}`);
    try {
      const res = await agentIssuesApi.experimentReport(orgId, issueId, linkId);
      toast.success(
        `Report: ${String((res.data?.report as Record<string, unknown>)?.recommendation ?? "ready")}`,
      );
      void experimentsQuery.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Report failed");
    } finally {
      setBusy(null);
    }
  };

  return {
    currentOrg,
    orgId,
    toast,
    tab,
    setTab,
    busy,
    issue,
    loading,
    error,
    isNotFound,
    issueQuery,
    preserve,
    stumbles,
    stumblesError,
    stumblesQuery,
    experiments,
    experimentsError,
    experimentsQuery,
    regressionCases,
    regressionError,
    regressionQuery,
    onTriage,
    onResolve,
    onExportFixture,
    onSaveRegression,
    onCreateExperiment,
    onExperimentReport,
  };
}
