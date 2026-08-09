"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Play, ShieldAlert } from "lucide-react";
import { PageHeader, StatusChip } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery, useOrgMutation } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { redteamApi, type RedteamFinding } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { QueryErrorPanel, QueryLoadingPanel } from "@/components/shell/query-error-panel";
import { NoWorkspaceGuard } from "@/components/shell/workspace-guard";
import { useLabToast } from "@/lab/lab-toast";
import { formatRelativeTime } from "@/lib/format";

const SEVERITY_TONE: Record<string, "fail" | "neutral" | "live"> = {
  critical: "fail",
  high: "fail",
  medium: "live",
  low: "neutral",
};

/**
 * `/guardrails/redteam` — red-team probes, scan runner, and findings
 * (FEAT-88). Backs the fully-built backend subsystem
 * (`src/eden/redteam/probes.py` + `api/routes/redteam.py`):
 * list the 12 named probes, run a scan against the org's target
 * endpoint, and review persisted findings.
 */
function RedteamInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const { pushToast } = useLabToast();
  const [targetEndpoint, setTargetEndpoint] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState<RedteamFinding[]>([]);

  const probesQuery = useOrgQuery(
    queryKeys.portal.redteamProbes(orgId),
    orgId,
    () => redteamApi.listProbes(orgId!),
    SHELL_QUERY,
  );
  const findingsQuery = useOrgQuery(
    queryKeys.portal.redteamFindings(orgId),
    orgId,
    () => redteamApi.listFindings(orgId!),
    SHELL_QUERY,
  );

  const runScan = useOrgMutation(
    async (endpoint: string) => {
      const res = await redteamApi.runScan(orgId!, {
        target_endpoint: endpoint || undefined,
        target_label: "manual-scan",
      });
      return res;
    },
    {
      onSuccess: (res) => {
        const findings = (res.runs ?? []).flatMap((r) => r.findings ?? []);
        setScanResults(findings);
        pushToast({
          title: "Scan complete",
          body: `${res.runs?.length ?? 0} probes · ${findings.length} findings`,
          tone: findings.length ? "fail" : "ok",
        });
        void findingsQuery.refetch();
      },
      onError: (err: Error) => {
        pushToast({ title: "Scan failed", body: err.message, tone: "fail" });
      },
    },
  );

  const totalFindings = useMemo(
    () => findingsQuery.data?.total ?? 0,
    [findingsQuery.data],
  );

  if (!orgId) {
    return (
      <NoWorkspaceGuard
        title="Red-team"
        message="Select a workspace to run red-team probes."
      />
    );
  }

  if (probesQuery.isLoading) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Red-team" />
        <QueryLoadingPanel label="Loading probes…" />
      </div>
    );
  }

  if (probesQuery.isError) {
    return (
      <div className="ds-page flex min-h-0 flex-1 flex-col">
        <PageHeader title="Red-team" />
        <QueryErrorPanel
          error={probesQuery.error}
          onRetry={() => void probesQuery.refetch()}
        />
      </div>
    );
  }

  const probes = probesQuery.data?.probes ?? [];

  const meta = (
    <span className="type-meta">
      {probes.length} probes · {totalFindings} persisted finding
      {totalFindings === 1 ? "" : "s"}
    </span>
  );

  return (
    <div className="ds-page flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Red-team"
        meta={meta}
        actions={
          <Link
            href="/guardrails"
            className="ds-btn ds-btn-outline"
            aria-label="Back to guardrails"
          >
            <ChevronLeft className="h-4 w-4" />
            Guardrails
          </Link>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Run-scan panel */}
        <section className="border-b border-[var(--line)] p-4 sm:p-5">
          <div className="ds-panel flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label
                htmlFor="redteam-target"
                className="type-meta mb-1 block text-[var(--text-muted)]"
              >
                Target endpoint (optional — leave blank to use the configured default)
              </label>
              <input
                id="redteam-target"
                className="ds-input w-full"
                placeholder="https://api.example.com/agent/chat"
                value={targetEndpoint}
                onChange={(e) => setTargetEndpoint(e.target.value)}
                disabled={scanning}
              />
            </div>
            <button
              type="button"
              className="ds-btn ds-btn-primary"
              disabled={scanning}
              onClick={() => {
                setScanning(true);
                setScanResults([]);
                void runScan
                  .mutateAsync(targetEndpoint.trim())
                  .finally(() => setScanning(false));
              }}
            >
              <Play className="h-4 w-4" />
              {scanning ? "Running…" : "Run scan"}
            </button>
          </div>

          {scanResults.length > 0 && (
            <div className="mt-3">
              <h3 className="type-ui mb-2 text-[var(--text-muted)]">
                Latest scan findings
              </h3>
              <div className="flex flex-col gap-2">
                {scanResults.map((f, i) => (
                  <div
                    key={`${f.probe_name}-${i}`}
                    className="rounded-md border border-[var(--line)] bg-[var(--bg)] p-3"
                  >
                    <div className="flex items-center gap-2">
                      <ShieldAlert className="h-4 w-4 text-[var(--warning)]" />
                      <span className="type-ui text-sm">{f.probe_name}</span>
                      <StatusChip tone={SEVERITY_TONE[f.severity] ?? "neutral"}>
                        {f.severity}
                      </StatusChip>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[var(--text-muted)]">
                      {f.detection_reason || f.attack_prompt || "No detail recorded."}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Findings list */}
        <section className="p-4 sm:p-5">
          <h3 className="type-ui mb-2 text-[var(--text-muted)]">
            Persisted findings
          </h3>
          {findingsQuery.isLoading ? (
            <QueryLoadingPanel label="Loading findings…" />
          ) : findingsQuery.isError ? (
            <QueryErrorPanel
              error={findingsQuery.error}
              onRetry={() => void findingsQuery.refetch()}
            />
          ) : (findingsQuery.data?.findings ?? []).length === 0 ? (
            <EmptyState
              title="No findings yet"
              body="Run a scan above — probe findings are persisted to the findings table and listed here."
              compact
            />
          ) : (
            <div className="flex flex-col gap-2">
              {(findingsQuery.data?.findings ?? []).map((f) => (
                <div
                  key={f.id}
                  className="rounded-md border border-[var(--line)] bg-[var(--bg)] p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="type-ui text-sm">{f.probe_name}</span>
                    <StatusChip tone={SEVERITY_TONE[f.severity] ?? "neutral"}>
                      {f.severity}
                    </StatusChip>
                    <span className="type-meta text-[var(--text-faint)]">
                      {f.category} · {formatRelativeTime(f.created_at)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-[var(--text-muted)]">
                    {f.attack_prompt || "No attack prompt recorded."}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Probe catalog */}
        <section className="border-t border-[var(--line)] p-4 sm:p-5">
          <h3 className="type-ui mb-2 text-[var(--text-muted)]">Probe catalog</h3>
          <div className="grid min-h-0 grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {probes.map((p) => (
              <div
                key={p.name}
                className="rounded-md border border-[var(--line)] bg-[var(--bg)] p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="type-ui text-sm">{p.name}</span>
                  <StatusChip tone="neutral">{p.severity}</StatusChip>
                </div>
                <p className="type-meta mt-1 text-[var(--text-muted)]">
                  {p.category}
                </p>
                <p className="mt-1 line-clamp-2 text-sm text-[var(--text-faint)]">
                  {p.description}
                </p>
                <p className="type-meta mt-1 text-[var(--text-faint)]">
                  {p.prompt_count} prompt{p.prompt_count === 1 ? "" : "s"}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export default function RedteamPage() {
  return <RedteamInner />;
}
