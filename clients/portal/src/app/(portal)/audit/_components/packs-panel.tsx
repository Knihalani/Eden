"use client";

import { useEffect, useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { complianceApi, fleetApi } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { QueryState } from "@/components/ui/query-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, Loader2, ShieldCheck } from "lucide-react";

export const PAGE_SIZE = 50;
export const MAX_LIMIT = 500;

function defaultPeriod() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  return {
    period_start: start.toISOString().slice(0, 10),
    period_end: end.toISOString().slice(0, 10),
  };
}

export function PacksPanel({
  orgId,
  agentFilter,
  onAgentFilterChange,
}: {
  orgId: string;
  agentFilter: string;
  onAgentFilterChange: (id: string) => void;
}) {
  const toast = useToast();
  const [verify, setVerify] = useState<{
    verified: boolean;
    total_rows: number;
    ok_rows: number;
    broken_rows: number;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [exportAgent, setExportAgent] = useState("");
  const [exporting, setExporting] = useState(false);
  const [period, setPeriod] = useState(defaultPeriod);

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [agentFilter]);

  const ledgerFilters = {
    agent_id: agentFilter || undefined,
    limit,
  };
  const ledgerQuery = useOrgQuery(
    queryKeys.auditTrail.ledger(orgId, ledgerFilters),
    orgId,
    async () => {
      const ledgerRes = await complianceApi.ledger(orgId, {
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

  const fleetQuery = useOrgQuery(
    queryKeys.auditTrail.fleetAgents(orgId),
    orgId,
    async () => {
      try {
        const fleetRes = await fleetApi.summary(orgId);
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

  useEffect(() => {
    if (!exportAgent && agents.length > 0) setExportAgent(agents[0]!);
  }, [agents, exportAgent]);

  const runVerify = async () => {
    setVerifying(true);
    try {
      const res = await complianceApi.verifyChain(orgId, {
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
    const agentId = exportAgent || agentFilter;
    if (!agentId) {
      toast.error("Select an agent scope to generate a pack");
      return;
    }
    setExporting(true);
    try {
      const res = await complianceApi.exportPack(orgId, agentId, {
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
      a.download = `audit-pack-${agentId}-${period.period_end}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("AuditPack downloaded");
      await ledgerQuery.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-space-4">
      <Panel tone="flat" padding="md" className="space-y-space-3" data-testid="audit-generate-pack">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Generate AuditPack
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              Export org events for a time range and optional agent. Download starts when the pack is ready.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => void runExport()}
            disabled={exporting || (!exportAgent && agents.length === 0)}
          >
            {exporting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
                Generating…
              </>
            ) : (
              <>
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                Generate pack
              </>
            )}
          </Button>
        </div>
        <div className="flex flex-wrap gap-space-2">
          <select
            value={exportAgent || agentFilter}
            onChange={(e) => setExportAgent(e.target.value)}
            className="rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-2 py-space-1.5 text-xs min-h-11"
            aria-label="Agent scope"
          >
            <option value="">All agents (org-wide ledger)</option>
            {agents.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={period.period_start}
            onChange={(e) =>
              setPeriod((p) => ({ ...p, period_start: e.target.value }))
            }
            className="rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-2 py-space-1.5 text-xs min-h-11"
            aria-label="Period start"
          />
          <input
            type="date"
            value={period.period_end}
            onChange={(e) =>
              setPeriod((p) => ({ ...p, period_end: e.target.value }))
            }
            className="rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-2 py-space-1.5 text-xs min-h-11"
            aria-label="Period end"
          />
        </div>
        {verify ? (
          <p
            className={`text-xs font-medium ${
              verify.verified
                ? "text-[var(--terminal)]"
                : "text-[var(--error)]"
            }`}
          >
            {verify.verified ? "Chain attestation passed" : "Chain attestation failed"} —{" "}
            {verify.ok_rows}/{verify.total_rows} rows OK
          </p>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void runVerify()}
          disabled={verifying}
        >
          {verifying ? "Verifying…" : "Verify chain"}
        </Button>
      </Panel>

      <div
        data-testid="audit-trail-toolbar"
        className="flex flex-wrap items-center gap-space-2"
      >
        <label
          className="text-xs text-[var(--text-muted)]"
          htmlFor="chain-agent-filter"
        >
          Filter agent
        </label>
        <select
          id="chain-agent-filter"
          value={agentFilter}
          onChange={(e) => onAgentFilterChange(e.target.value)}
          className="min-h-11 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-2 py-space-1.5 text-xs"
        >
          <option value="">All agents</option>
          {agentFilter && !agents.includes(agentFilter) ? (
            <option value={agentFilter}>{agentFilter}</option>
          ) : null}
          {agents.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        {events.length > 0 ? (
          <span className="text-xs text-[var(--text-muted)]">
            Showing {events.length} events
          </span>
        ) : null}
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
            title="No chain events yet"
            description="Autonomous actions, promotions, and config changes appear here as agents run. Connect an agent or promote an artifact to seed the trail. Switch to Events for workspace admin actions."
          />
        }
      >
        {(payload) => (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border-subtle)]">
                    <th className="text-left p-2 text-[var(--text-muted)] font-medium">
                      When
                    </th>
                    <th className="text-left p-2 text-[var(--text-muted)] font-medium">
                      Type
                    </th>
                    <th className="text-left p-2 text-[var(--text-muted)] font-medium">
                      Agent
                    </th>
                    <th className="text-left p-2 text-[var(--text-muted)] font-medium">
                      Actor
                    </th>
                    <th className="text-left p-2 text-[var(--text-muted)] font-medium">
                      Hash
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {payload.events.map((e) => (
                    <tr
                      key={e.id}
                      className="border-b border-[var(--border-subtle)]/60 hover:bg-[var(--bg-secondary)]/50"
                    >
                      <td className="p-2 text-[var(--text-muted)] whitespace-nowrap">
                        {e.created_at
                          ? new Date(e.created_at).toLocaleString()
                          : "—"}
                      </td>
                      <td className="p-2 font-mono">
                        {e.event_type}
                        {e.event_subtype ? `/${e.event_subtype}` : ""}
                      </td>
                      <td className="p-2 font-mono truncate max-w-[8rem]">
                        {e.agent_id ?? "—"}
                      </td>
                      <td className="p-2">{e.actor_type}</td>
                      <td className="p-2 font-mono text-[var(--text-muted)] truncate max-w-[10rem]">
                        {e.entry_hash?.slice(0, 12)}…
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canLoadMore ? (
              <div className="flex justify-center pt-4">
                <Button
                  variant="outline"
                  size="default"
                  onClick={() =>
                    setLimit((l) => Math.min(l + PAGE_SIZE, MAX_LIMIT))
                  }
                  loading={refreshing}
                  disabled={refreshing}
                >
                  Load more events
                </Button>
              </div>
            ) : null}
          </>
        )}
      </QueryState>
    </div>
  );
}
