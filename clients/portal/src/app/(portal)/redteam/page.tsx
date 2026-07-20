"use client";

import { useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
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
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { redteamApi } from "@/lib/api";

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
    <PageContent size="wide">
      <PageHeader
        eyebrow="Safety"
        title="Red team"
        subtitle="Adversarial probes run against your agent endpoint. Findings appear here with severity and category."
        icon={ShieldAlert}
        actions={
          <Button
            onClick={() => refetch()}
            variant="outline"
            size="sm"
            disabled={loading}
            loading={loading}
            aria-label="Refresh findings"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        }
      />

      <Card className="p-4">
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="Target endpoint URL (POST JSON { prompt })"
            value={targetEndpoint}
            onChange={(e) => setTargetEndpoint(e.target.value)}
            className="flex-1 min-h-[44px]"
            aria-label="Target endpoint URL"
            disabled={submitting}
          />
          <Button
            onClick={submit}
            disabled={!targetEndpoint.trim() || submitting}
            loading={submitting}
            className="min-h-[44px]"
            aria-label="Run red team scan"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
            {submitting ? "Running…" : "Run scan"}
          </Button>
        </div>
      </Card>

      {scanError ? (
        <ErrorState
          title="Could not start scan"
          message={scanError}
          action={
            <Button
              onClick={() => setScanError(null)}
              variant="outline"
              size="sm"
            >
              Dismiss
            </Button>
          }
        />
      ) : null}

      {error ? (
        <ErrorState
          title="Could not load findings"
          message={error.message}
          action={
            <Button onClick={() => refetch()} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      ) : (
        <Card className="p-2">
          <DataTable
            loading={loading}
            rows={findings ?? []}
            rowKey={(r) => r.id}
            emptyTitle="No findings"
            emptyDescription="Run a scan against a target endpoint to surface adversarial findings."
            emptyIcon={ShieldAlert}
            columns={[
              { key: "probe_name", header: "Probe", sortable: true },
              { key: "category", header: "Category", sortable: true },
              { key: "severity", header: "Severity", sortable: true, cell: (r) => <SeverityBadge severity={r.severity} /> },
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
              { key: "created_at", header: "Found", sortable: true, cell: (r) => new Date(r.created_at).toLocaleString() },
            ]}
          />
        </Card>
      )}
    
    </PageContent>
  );
}
