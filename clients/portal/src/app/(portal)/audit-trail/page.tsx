"use client";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage, CrossLinkBar } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { QueryState } from "@/components/ui/query-state";
import { Skeleton } from "@/components/ui/skeleton";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { complianceApi, fleetApi } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, ShieldCheck, Download, Link2 } from "lucide-react";

const PAGE_SIZE = 50;
const MAX_LIMIT = 500;

function defaultPeriod() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  };
}

function AuditTrailPageInner() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();
  const searchParams = useSearchParams();
  const [verify, setVerify] = useState<{
    verified: boolean;
    total_rows: number;
    ok_rows: number;
    broken_rows: number;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [agentFilter, setAgentFilter] = useState(
    () => searchParams.get("agent") ?? "",
  );
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [exportAgent, setExportAgent] = useState("");
  const [exporting, setExporting] = useState(false);
  const [period, setPeriod] = useState(defaultPeriod);

  useEffect(() => {
    const fromUrl = searchParams.get("agent") ?? "";
    setAgentFilter((prev) => (prev === fromUrl ? prev : fromUrl));
  }, [searchParams]);

  const ledgerFilters = {
    agent_id: agentFilter || undefined,
    limit,
  };
  const ledgerQuery = useOrgQuery(
    queryKeys.auditTrail.ledger(orgId, ledgerFilters),
    orgId,
    async () => {
      const ledgerRes = await complianceApi.ledger(orgId!, {
        agent_id: agentFilter || undefined,
        limit,
      });
      const events = ledgerRes.data?.events ?? [];
      return {
        events,
        count: ledgerRes.data?.count ?? events.length,
      };
    },
  );
  // Fleet is preview-gated (fleet_health_v1); soft-fail so a missing
  // fleet summary cannot blank the whole audit trail page.
  const fleetQuery = useOrgQuery(
    queryKeys.auditTrail.fleetAgents(orgId),
    orgId,
    async () => {
      try {
        const fleetRes = await fleetApi.summary(orgId!);
        return (fleetRes.data?.agents ?? []).map((a) => a.agent_id);
      } catch {
        return [] as string[];
      }
    },
  );

  const events = ledgerQuery.data?.events ?? [];
  const agents = fleetQuery.data ?? [];
  const loading = ledgerQuery.isLoading;
  const refreshing = ledgerQuery.isFetching;
  const errorMessage = ledgerQuery.error?.message ?? null;
  const canLoadMore =
    !loading &&
    !errorMessage &&
    limit < MAX_LIMIT &&
    events.length === limit;
  const loadMore = () => setLimit((l) => Math.min(l + PAGE_SIZE, MAX_LIMIT));

  useEffect(() => {
    if (!exportAgent && agents.length > 0) setExportAgent(agents[0]!);
  }, [agents, exportAgent]);

  const runVerify = async () => {
    if (!currentOrg) return;
    setVerifying(true);
    try {
      const res = await complianceApi.verifyChain(currentOrg.id, {
        agent_id: agentFilter || undefined,
      });
      const data = res.data;
      if (data) {
        setVerify(data);
        toast.success(
          data.verified
            ? `Chain verified (${data.ok_rows}/${data.total_rows} rows)`
            : `Chain broken (${data.broken_rows} rows)`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verify failed");
    } finally {
      setVerifying(false);
    }
  };

  const runExport = async () => {
    if (!currentOrg || !exportAgent) return;
    setExporting(true);
    try {
      const res = await complianceApi.exportPack(currentOrg.id, exportAgent, {
        period_start: period.period_start,
        period_end: period.period_end,
        framework: "soc2_type_ii",
      });
      const blob = new Blob([JSON.stringify(res.data ?? res, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-trail-${exportAgent}-${period.period_end}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Compliance pack downloaded");
      await ledgerQuery.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const eventTypes = useMemo(
    () => [...new Set(events.map((e) => e.event_type))].sort(),
    [events],
  );

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="Audit trail"
        icon={ShieldCheck}
        description="Select an organization to view chain-verified agent audit events and export compliance packs."
      />
    );
  }

  return (
    <CoreResourcePage
      size="default"
      header={
        <PageHeader
          title="Audit trail"
          subtitle="Append-only agent events with hash-chain attestation for regulated deployments."
          description="Export SOC2/HIPAA compliance packs. This is separate from The Book (Ledger) memory product."
          actions={
            <Button size="sm" onClick={() => void runVerify()} disabled={verifying}>
              {verifying ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Link2 className="h-4 w-4 mr-2" />}
              Verify chain
            </Button>
          }
        />
      }
      toolbar={
        <CrossLinkBar
          links={[
            { label: "Agents", href: "/agents" },
            { label: "Fleet", href: "/agents?tab=fleet" },
            { label: "Ledger", href: "/ledger" },
            { label: "Settings audit", href: "/settings?tab=audit-log" },
          ]}
        />
      }
      table={
        <>
      <div className="grid gap-4 md:grid-cols-2 mb-6">
        <Panel tone="flat" padding="md" className="space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Chain verification</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Recompute SHA-256 hashes across the agent audit ledger to detect tampering.
          </p>
          {verify && (
            <p className={`text-xs font-medium ${verify.verified ? "text-[var(--terminal)]" : "text-[var(--error)]"}`}>
              {verify.verified ? "Attestation passed" : "Attestation failed"} — {verify.ok_rows}/{verify.total_rows} rows OK
            </p>
          )}
        </Panel>

        <Panel tone="flat" padding="md" className="space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Compliance pack export</h2>
          <div className="flex flex-wrap gap-2">
            <select
              value={exportAgent}
              onChange={(e) => setExportAgent(e.target.value)}
              className="rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs"
            >
              {agents.length === 0 ? <option value="">No agents</option> : null}
              {agents.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
            <input
              type="date"
              value={period.period_start}
              onChange={(e) => setPeriod((p) => ({ ...p, period_start: e.target.value }))}
              className="rounded-md border border-[var(--border-default)] px-2 py-1.5 text-xs"
            />
            <input
              type="date"
              value={period.period_end}
              onChange={(e) => setPeriod((p) => ({ ...p, period_end: e.target.value }))}
              className="rounded-md border border-[var(--border-default)] px-2 py-1.5 text-xs"
            />
          </div>
          <Button size="sm" variant="outline" onClick={() => void runExport()} disabled={exporting || !exportAgent}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Download className="h-4 w-4 mr-2" />}
            Download JSON pack
          </Button>
        </Panel>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-xs text-[var(--text-muted)]">Filter agent</label>
        <select
          value={agentFilter}
          onChange={(e) => {
            setAgentFilter(e.target.value);
            setLimit(PAGE_SIZE);
          }}
          className="rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1.5 text-xs"
        >
          <option value="">All agents</option>
          {agentFilter && !agents.includes(agentFilter) ? (
            <option value={agentFilter}>{agentFilter}</option>
          ) : null}
          {agents.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>
        {eventTypes.length > 0 && (
          <span className="text-xs text-[var(--text-muted)]">
            Showing {events.length} events · types: {eventTypes.join(", ")}
          </span>
        )}
      </div>

      <QueryState
        loading={loading}
        error={ledgerQuery.error}
        data={ledgerQuery.data}
        onRetry={() => void ledgerQuery.refetch()}
        errorTitle="Could not load audit trail"
        isEmpty={(d) => (d?.events.length ?? 0) === 0}
        loadingSlot={
          <div className="space-y-2 py-4" aria-busy="true">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        }
        emptySlot={
          <EmptyState
            variant="plain"
            icon={ShieldCheck}
            title="No audit events yet"
            description="Autonomous actions, promotions, and config changes appear here as your agents run. Connect an agent or promote an artifact to seed the trail."
          />
        }
      >
        {(payload) => (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left p-2 text-[var(--text-muted)] font-medium">When</th>
                    <th className="text-left p-2 text-[var(--text-muted)] font-medium">Type</th>
                    <th className="text-left p-2 text-[var(--text-muted)] font-medium">Agent</th>
                    <th className="text-left p-2 text-[var(--text-muted)] font-medium">Actor</th>
                    <th className="text-left p-2 text-[var(--text-muted)] font-medium">Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.events.map((e) => (
                    <tr key={e.id} className="border-b border-[var(--border-subtle)]/60 hover:bg-[var(--bg-secondary)]/50">
                      <td className="p-2 text-[var(--text-muted)] whitespace-nowrap">
                        {e.created_at ? new Date(e.created_at).toLocaleString() : "—"}
                      </td>
                      <td className="p-2 font-mono">
                        {e.event_type}
                        {e.event_subtype ? `/${e.event_subtype}` : ""}
                      </td>
                      <td className="p-2 font-mono truncate max-w-[8rem]">{e.agent_id ?? "—"}</td>
                      <td className="p-2">{e.actor_type}</td>
                      <td className="p-2 font-mono text-[var(--text-muted)] truncate max-w-[10rem]">
                        {e.entry_hash?.slice(0, 12)}…
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canLoadMore && (
              <div className="flex justify-center pt-4">
                <Button
                  variant="outline"
                  size="default"
                  onClick={loadMore}
                  loading={refreshing}
                  disabled={refreshing}
                >
                  Load more events
                </Button>
              </div>
            )}
          </>
        )}
      </QueryState>
        </>
      }
    />
  );
}

export default function AuditTrailPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-2 p-6" aria-busy="true">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      }
    >
      <AuditTrailPageInner />
    </Suspense>
  );
}
