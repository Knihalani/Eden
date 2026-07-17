"use client";

import Link from "next/link";
import { useState, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";
import { RefreshCw, Rewind } from "lucide-react";
import { debuggerApi, type Checkpoint, type RerunResult } from "@/lib/api";

export default function DebuggerPage() {
  const { currentOrg } = useOrg();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [traceId, setTraceId] = useState(searchParams.get("trace_id") ?? "");
  const [promptOverride, setPromptOverride] = useState("");
  const [livePrefix, setLivePrefix] = useState(true);
  const [lastDiff, setLastDiff] = useState<RerunResult["diff"]>([]);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    const tid = traceId.trim();
    if (!tid) {
      setCheckpoints([]);
      return;
    }
    setLoading(true);
    try {
      const res = await debuggerApi.listCheckpoints(currentOrg.id, tid);
      setCheckpoints(res.checkpoints || []);
      setLastDiff([]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load checkpoints";
      toast.error(msg);
      setCheckpoints([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast, traceId]);

  // Auto-load checkpoints when trace_id is provided via ?trace_id= deep-link.
  useEffect(() => {
    if (traceId.trim() && currentOrg?.id) {
      void load();
    }
    // Only run on mount / when org first becomes available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg?.id]);

  if (!currentOrg) return <NoOrgState feature="Debugger" />;

  const filtered = checkpoints.filter((c) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      c.source.toLowerCase().includes(q) ||
      c.trace_id.toLowerCase().includes(q) ||
      String(c.step_number).includes(q)
    );
  });

  return (
    <PageContent size="wide">
      <PageHeader
        title="Agent debugger"
        subtitle="Time-travel checkpoints. Enter a trace id to list saved steps, then re-run from a step."
        actions={
          <>
            <Link
              href="/debugger-sessions"
              className="text-xs text-[var(--accent)] hover:underline mr-2"
            >
              Debug sessions
            </Link>
            <input
              value={traceId}
              onChange={(e) => setTraceId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load();
              }}
              placeholder="Trace id"
              className="h-8 w-56 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elev-1)] px-2 text-xs font-mono"
              aria-label="Trace id"
            />
            <input
              value={promptOverride}
              onChange={(e) => setPromptOverride(e.target.value)}
              placeholder="Optional prompt override"
              className="h-8 w-56 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elev-1)] px-2 text-xs"
              aria-label="Prompt override"
            />
            <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={livePrefix}
                onChange={(e) => setLivePrefix(e.target.checked)}
              />
              Cached-prefix live (F01)
            </label>
            <DataTableSearch value={filter} onChange={setFilter} placeholder="Filter steps" />
            <Button onClick={load} variant="outline" size="sm" disabled={loading || !traceId.trim()}>
              <RefreshCw className="h-3.5 w-3.5" /> Load
            </Button>
          </>
        }
      />

      <Card className="p-2">
        <DataTable
          loading={loading}
          rows={filtered}
          rowKey={(r) => r.id}
          emptyTitle={traceId.trim() ? "No checkpoints for this trace" : "Enter a trace id"}
          emptyDescription={
            traceId.trim()
              ? "Checkpoints are written on each LLM span during ingest (F03). If this trace predates checkpoint ingest, re-run the agent or pick a newer trace."
              : "Checkpoints are scoped per trace. Paste a trace id and click Load."
          }
          columns={[
            {
              key: "source",
              header: "Source",
              sortable: true,
              cell: (r) => <span className="text-xs">{r.source || "—"}</span>,
            },
            {
              key: "trace_id",
              header: "Trace",
              cell: (r) => <span className="font-mono text-xs">{r.trace_id}</span>,
            },
            { key: "step_number", header: "Step", align: "right", sortable: true },
            {
              key: "duration_ms",
              header: "Duration",
              align: "right",
              cell: (r) => (
                <span className="text-xs text-[var(--text-muted)]">
                  {typeof r.duration_ms === "number" ? `${Math.round(r.duration_ms)}ms` : "—"}
                </span>
              ),
            },
            {
              key: "started_at",
              header: "Started",
              sortable: true,
              cell: (r) => (r.started_at ? new Date(r.started_at).toLocaleString() : "—"),
            },
            {
              key: "actions",
              header: "",
              align: "right",
              cell: (r) => (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      const result = await debuggerApi.rerun(currentOrg.id, {
                        trace_id: r.trace_id,
                        from_step: r.step_number,
                        live_prefix: livePrefix,
                        ...(promptOverride.trim()
                          ? { prompt_override: promptOverride.trim() }
                          : {}),
                      });
                      setLastDiff(result.diff || []);
                      toast.success(
                        `Re-run complete: steps ${result.from_step}→${result.to_step}` +
                          (result.diff?.length ? ` (${result.diff.length} diffs)` : ""),
                      );
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Re-run failed");
                    }
                  }}
                >
                  <Rewind className="h-3 w-3" /> Re-run
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {lastDiff.length > 0 && (
        <Card className="mt-4 p-4 space-y-3">
          <h3 className="text-sm font-medium">Rerun diff</h3>
          {lastDiff.map((d) => (
            <div
              key={d.step_number}
              className="grid gap-2 md:grid-cols-2 rounded-md border border-[var(--border-subtle)] p-3 text-xs font-mono"
            >
              <div>
                <div className="mb-1 text-[var(--text-muted)]">Step {d.step_number} · original</div>
                <pre className="whitespace-pre-wrap break-all">
                  {JSON.stringify(d.original_response, null, 2)}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-[var(--text-muted)]">
                  Step {d.step_number} · replayed
                  {d.input_messages_changed ? " · inputs changed" : ""}
                </div>
                <pre className="whitespace-pre-wrap break-all">
                  {JSON.stringify(d.replayed_response, null, 2)}
                </pre>
              </div>
            </div>
          ))}
        </Card>
      )}
    </PageContent>
  );
}
