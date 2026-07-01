"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/ui/data-table";
import { SeverityBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { redteamApi, type RedteamFinding } from "@/lib/api";

export default function RedteamPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [findings, setFindings] = useState<RedteamFinding[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await redteamApi.listFindings(currentOrg.id);
      setFindings(res.findings || []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load findings";
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  if (!currentOrg) return <NoOrgState feature="Red team" />;

  const submit = async () => {
    if (!target.trim() || !currentOrg?.id) return;
    setSubmitting(true);
    try {
      await redteamApi.runScan(currentOrg.id, {
        probe_ids: ["jailbreak", "prompt-injection", "pii-leak"],
        target_prompt: target,
      });
      toast.success("Scan queued");
      setTarget("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to queue scan");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6 page-enter">
      <PageHeader
        eyebrow="Safety"
        title="Red team"
        subtitle="Adversarial probes run against your prompts. Findings appear here with severity and category."
        icon={ShieldAlert}
        actions={
          <Button
            onClick={load}
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
            placeholder="Target prompt (the system prompt under test)"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="flex-1"
            aria-label="Target prompt"
            disabled={submitting}
          />
          <Button
            onClick={submit}
            disabled={!target.trim() || submitting}
            loading={submitting}
            aria-label="Run red team scan"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldAlert className="h-3.5 w-3.5" />}
            {submitting ? "Running…" : "Run scan"}
          </Button>
        </div>
      </Card>

      {error ? (
        <ErrorState
          title="Could not load findings"
          message={error}
          action={
            <Button onClick={load} variant="outline" size="sm" disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </Button>
          }
        />
      ) : (
        <Card className="p-2">
          <DataTable
            loading={loading}
            rows={findings}
            rowKey={(r) => r.id}
            emptyTitle="No findings"
            emptyDescription="Run a scan against a target prompt to surface adversarial findings."
            emptyIcon={ShieldAlert}
            columns={[
              { key: "probe", header: "Probe", sortable: true },
              { key: "category", header: "Category", sortable: true },
              { key: "severity", header: "Severity", sortable: true, cell: (r) => <SeverityBadge severity={r.severity} /> },
              {
                key: "prompt",
                header: "Probe prompt",
                cell: (r) => (
                  <span className="font-mono text-xs">
                    {r.prompt.slice(0, 80)}
                    {r.prompt.length > 80 ? "…" : ""}
                  </span>
                ),
              },
              { key: "created_at", header: "Found", sortable: true, cell: (r) => new Date(r.created_at).toLocaleString() },
            ]}
          />
        </Card>
      )}
    </div>
  );
}