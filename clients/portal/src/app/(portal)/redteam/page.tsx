"use client";

import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/ui/data-table";
import { SeverityBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { interpretRedteamScan } from "@/lib/eval-run-outcome";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { redteamApi } from "@/lib/api";
import { QueryState } from "@/components/ui/query-state";
import { EmptyState } from "@/components/ui/empty-state";

export default function RedteamPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const toast = useToast();
  const [targetEndpoint, setTargetEndpoint] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const {
    data: findings,
    isLoading: loading,
    error,
    refetch,
  } = useOrgQuery(
    queryKeys.redteam.findings(orgId),
    orgId,
    async () => {
      const res = await redteamApi.listFindings(orgId!);
      return res.findings ?? [];
    },
  );

  if (!currentOrg) return <NoOrgState feature="Red team" />;

  const submit = async () => {
    if (!targetEndpoint.trim() || !orgId) return;
    setSubmitting(true);
    setScanError(null);
    try {
      const res = await redteamApi.runScan(orgId, {
        target_endpoint: targetEndpoint.trim(),
        target_label: "portal-scan",
      });
      const outcome = interpretRedteamScan(res);
      if (outcome.kind === "empty") {
        setScanError(outcome.message);
        toast.error("Scan did not run", outcome.message);
        return;
      }
      if (outcome.kind === "findings") {
        toast.success(
          "Scan complete",
          `${outcome.findingCount} finding${outcome.findingCount === 1 ? "" : "s"} detected`,
        );
      } else {
        toast.success("Scan complete", "No findings — target resisted probes");
      }
      setTargetEndpoint("");
      refetch();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to run scan";
      setScanError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-wave10-redteam="signed">
    <PageContent size="wide">
      <PageHeader
        eyebrow="Safety"
        title="Red team"
        subtitle="Adversarial probes against your agent endpoint."
        icon={ShieldAlert}
        actions={
          <Button
            onClick={() => refetch()}
            variant="outline"
            className="min-h-11"
            disabled={loading}
            loading={loading}
            aria-label="Refresh findings"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        }
      />

      <div className="mb-space-4 border-y border-[var(--border-subtle)] py-space-4">
        <div className="flex flex-col gap-space-3 sm:flex-row sm:items-end">
          <div className="w-full flex-1 space-y-space-1">
            <label htmlFor="redteam-endpoint" className="block text-xs font-medium text-[var(--text-muted)]">
              Target endpoint
            </label>
            <Input
              id="redteam-endpoint"
              placeholder="Target endpoint URL (POST JSON { prompt })"
              value={targetEndpoint}
              onChange={(e) => setTargetEndpoint(e.target.value)}
              className="min-h-11 flex-1"
              aria-label="Target endpoint URL"
              disabled={submitting}
            />
          </div>
          <Button
            onClick={submit}
            disabled={!targetEndpoint.trim()}
            loading={submitting}
            className="min-h-11"
            aria-label="Run red team scan"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            Run scan
          </Button>
        </div>
      </div>

      {scanError ? (
        <ErrorState
          title="Could not start scan"
          message={scanError}
          action={
            <Button
              onClick={() => setScanError(null)}
              variant="outline"
              className="min-h-11"
            >
              Dismiss
            </Button>
          }
        />
      ) : null}

      <QueryState
        loading={loading && !findings}
        error={error}
        data={findings ?? []}
        onRetry={() => void refetch()}
        errorTitle="Could not load findings"
        isEmpty={(rows) => rows.length === 0}
        emptySlot={
          <EmptyState
            icon={ShieldAlert}
            title="No findings"
            description="Run a scan against a target endpoint to surface adversarial findings."
            variant="plain"
          />
        }
      >
        {(rows) => (
          <div className="border-y border-[var(--border-subtle)] py-space-2">
            <DataTable
              loading={loading}
              rows={rows}
              rowKey={(r) => r.id}
              emptyTitle="No findings"
              emptyDescription="Run a scan against a target endpoint to surface adversarial findings."
              emptyIcon={ShieldAlert}
              columns={[
                { key: "probe_name", header: "Probe", sortable: true },
                { key: "category", header: "Category", sortable: true },
                {
                  key: "severity",
                  header: "Severity",
                  sortable: true,
                  cell: (r) => <SeverityBadge severity={r.severity} />,
                },
                {
                  key: "attack_prompt",
                  header: "Probe prompt",
                  cell: (r) => (
                    <span className="font-mono text-xs">
                      {r.attack_prompt.slice(0, 80)}
                      {r.attack_prompt.length > 80 ? "…" : ""}
                    </span>
                  ),
                },
                {
                  key: "created_at",
                  header: "Found",
                  sortable: true,
                  cell: (r) => new Date(r.created_at).toLocaleString(),
                },
              ]}
            />
          </div>
        )}
      </QueryState>
    </PageContent>
    </div>
  );
}
