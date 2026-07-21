"use client";

import Link from "next/link";
import { Suspense, useState, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableSearch } from "@/components/ui/data-table";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { CoreResourcePage } from "@/components/portal-os";
import { LoadingSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { RefreshCw, Rewind } from "lucide-react";
import { debuggerApi, type Checkpoint, type RerunResult } from "@/lib/api";
import { U20_EMPTY_COPY } from "@/lib/portal-polish";
import {
  ObserveBackToTraces,
  ObserveLeafHeader,
  WAVE10_POWER_ATTR,
} from "@/app/(portal)/observability/_components/observe-leaf-shell";

function DebuggerInner() {
  const { currentOrg } = useOrg();
  const searchParams = useSearchParams();
  const toast = useToast();
  const initialTrace = searchParams.get("trace_id") ?? "";
  const initialSession = searchParams.get("session_id") ?? "";
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(Boolean(initialTrace.trim()));
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [traceId, setTraceId] = useState(initialTrace);
  const [sessionId, setSessionId] = useState(initialSession);
  const [promptOverride, setPromptOverride] = useState("");
  const [livePrefix, setLivePrefix] = useState(true);
  const [lastDiff, setLastDiff] = useState<RerunResult["diff"]>([]);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    const tid = traceId.trim();
    if (!tid) {
      setCheckpoints([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await debuggerApi.listCheckpoints(currentOrg.id, tid);
      setCheckpoints(res.checkpoints || []);
      setLastDiff([]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load checkpoints";
      setError(msg);
      setCheckpoints([]);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, traceId]);

  // Auto-load checkpoints when trace_id is provided via ?trace_id= deep-link.
  useEffect(() => {
    if (traceId.trim() && currentOrg?.id) {
      void load();
    }
    // Only run on mount / when org first becomes available.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional deep-link once
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
    <div {...WAVE10_POWER_ATTR}>
    <CoreResourcePage
      size="wide"
      header={
        <>
          <ObserveBackToTraces />
          <ObserveLeafHeader
            title="Debugger"
            subtitle="Checkpoints + prefix rerun — open from Traces More"
            actions={
              <Button asChild variant="outline" size="sm" className="min-h-11">
                <Link href="/debugger-sessions">Debug sessions</Link>
              </Button>
            }
          />
        </>
      }
      toolbar={
        <div
          className="flex flex-col gap-space-2 lg:flex-row lg:flex-wrap lg:items-center"
          data-testid="debugger-toolbar"
        >
          <input
            value={traceId}
            onChange={(e) => setTraceId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void load();
            }}
            placeholder="Trace id"
            className="h-11 w-full lg:w-56 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elev-1)] px-space-2 text-xs font-mono"
            aria-label="Trace id"
          />
          <input
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="Optional session id (F74)"
            className="h-11 w-full lg:w-56 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elev-1)] px-space-2 text-xs font-mono"
            aria-label="Debug session id"
          />
          <input
            value={promptOverride}
            onChange={(e) => setPromptOverride(e.target.value)}
            placeholder="Optional prompt override"
            className="h-11 w-full lg:w-56 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elev-1)] px-space-2 text-xs"
            aria-label="Prompt override"
          />
          <label className="flex min-h-11 items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <input
              type="checkbox"
              checked={livePrefix}
              onChange={(e) => setLivePrefix(e.target.checked)}
            />
            Cached-prefix live (F01)
          </label>
          <DataTableSearch value={filter} onChange={setFilter} placeholder="Filter steps" />
          <Button
            onClick={load}
            variant="outline"
            size="sm"
            className="min-h-11"
            disabled={loading || !traceId.trim()}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Load
          </Button>
        </div>
      }
      table={
        <>
          {error ? (
            <ErrorState
              title="Could not load checkpoints"
              message={error}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11"
                  onClick={() => void load()}
                  disabled={loading}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Try again
                </Button>
              }
            />
          ) : (
            <div className="rounded-lg border border-[var(--border-subtle)] p-space-2">
              <DataTable
                loading={loading}
                rows={filtered}
                rowKey={(r) => r.id}
                emptyTitle={traceId.trim() ? "No checkpoints for this trace" : "Enter a trace id"}
                emptyDescription={
                  traceId.trim()
                    ? "Checkpoints are written on each LLM span during ingest (F03). If this trace predates checkpoint ingest, re-run the agent or pick a newer trace."
                    : U20_EMPTY_COPY.debugger
                }
                emptyAction={
                  <Button asChild size="sm" variant={traceId.trim() ? "outline" : "default"}>
                    <Link href="/traces">
                      {traceId.trim() ? "Browse traces" : "Open traces"}
                    </Link>
                  </Button>
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
                        className="min-h-11"
                        onClick={async () => {
                          try {
                            const result = await debuggerApi.rerun(currentOrg.id, {
                              trace_id: r.trace_id,
                              from_step: r.step_number,
                              live_prefix: livePrefix,
                              ...(promptOverride.trim()
                                ? { prompt_override: promptOverride.trim() }
                                : {}),
                              ...(sessionId.trim() ? { session_id: sessionId.trim() } : {}),
                            });
                            setLastDiff(result.diff || []);
                            toast.success(
                              `Re-run complete: steps ${result.from_step}→${result.to_step}` +
                                (result.diff?.length ? ` (${result.diff.length} diffs)` : "") +
                                (result.session_id ? " · attached to session" : ""),
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
            </div>
          )}

          {lastDiff.length > 0 && (
            <div className="mt-space-4 space-y-space-3 rounded-lg border border-[var(--border-subtle)] p-space-4">
              <h3 className="text-sm font-medium">Rerun diff</h3>
              {lastDiff.map((d) => (
                <div
                  key={d.step_number}
                  className="grid gap-2 rounded-md border border-[var(--border-subtle)] p-3 text-xs font-mono md:grid-cols-2"
                >
                  <div>
                    <div className="mb-1 text-[var(--text-muted)]">
                      Step {d.step_number} · original
                    </div>
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
            </div>
          )}
        </>
      }
    />
    </div>
  );
}

export default function DebuggerPage() {
  return (
    <Suspense fallback={<LoadingSkeleton variant="default" />}>
      <DebuggerInner />
    </Suspense>
  );
}
