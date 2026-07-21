"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Bug, GitCompare, Loader2 } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { debugSessionsApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageContent } from "@/components/layout/page-content";
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { traceHref } from "@/lib/portal-cross-links";
import { cn } from "@/lib/utils";

type DebugRun = {
  id: string;
  source_trace_id: string;
  from_step: number;
  rerun_mode: string;
  diff_summary?: Array<Record<string, unknown>>;
  created_at?: string;
};

type DebugSessionDetail = {
  id: string;
  title: string;
  source_trace_id?: string | null;
  notes?: string;
  runs: DebugRun[];
};

const SESSION_MODES = ["runs", "compare"] as const;

export default function DebuggerSessionDetailPage() {
  const { currentOrg } = useOrg();
  const params = useParams<{ id: string }>();
  const sessionId = params?.id;
  const toast = useToast();
  const [session, setSession] = useState<DebugSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<(typeof SESSION_MODES)[number]>("runs");

  const load = useCallback(async () => {
    if (!currentOrg?.id || !sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await debugSessionsApi.get(currentOrg.id, sessionId);
      // Backend returns 200 + { status: "not_found" } (no session key).
      if (!res.session || (res as { status?: string }).status === "not_found") {
        setSession(null);
        return;
      }
      setSession({
        ...res.session,
        runs: (res.session.runs ?? []) as DebugRun[],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Load failed";
      setError(msg);
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleRun = (runId: string) => {
    setSelected((prev) => {
      if (prev.includes(runId)) return prev.filter((id) => id !== runId);
      if (prev.length >= 2) return [prev[1], runId];
      return [...prev, runId];
    });
  };

  const onCompare = async () => {
    if (!currentOrg?.id || !sessionId || selected.length !== 2) return;
    try {
      const res = await debugSessionsApi.compare(
        currentOrg.id,
        sessionId,
        selected[0],
        selected[1],
      );
      setCompare(res);
      setMode("compare");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Compare failed");
    }
  };

  if (!currentOrg) return <NoOrgState feature="Debug sessions" icon={Bug} />;

  return (
    <PageContent size="wide" data-wave7-debugger="session-modes">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading session…
        </div>
      ) : error ? (
        <ErrorState
          title="Could not load session"
          message={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : !session ? (
        <EmptyState
          icon={Bug}
          title="Session not found"
          description="This debugger session may have been deleted or you may not have access."
          action={
            <Button size="sm" asChild variant="outline">
              <Link href="/debugger-sessions">Back to sessions</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-space-4">
          <PageHeader
            title={session.title}
            subtitle={
              <>
                <Link
                  href="/debugger-sessions"
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  Debug sessions
                </Link>
                {session.source_trace_id ? (
                  <>
                    {" · source "}
                    <Link
                      href={traceHref(session.source_trace_id)}
                      className="font-mono text-[var(--accent)] hover:underline"
                    >
                      {session.source_trace_id}
                    </Link>
                  </>
                ) : null}
              </>
            }
            actions={
              <Button
                size="sm"
                variant="outline"
                disabled={selected.length !== 2}
                onClick={() => void onCompare()}
              >
                <GitCompare className="mr-1 h-3.5 w-3.5" /> Compare selected
              </Button>
            }
          />

          {/* Trace-detail grammar: one segmented mode control (Runs | Compare) */}
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as (typeof SESSION_MODES)[number])}
          >
            <TabsList
              variant="underline"
              aria-label="Session modes"
              className="h-auto w-full justify-start gap-1 bg-transparent"
              data-wave7-debugger="mode-tabs"
            >
              <TabsTrigger variant="underline" value="runs" className="min-h-11">
                Runs ({session.runs.length})
              </TabsTrigger>
              <TabsTrigger variant="underline" value="compare" className="min-h-11">
                Compare
              </TabsTrigger>
            </TabsList>

            <TabsContent value="runs" className="mt-3">
              {session.runs.length === 0 ? (
                <EmptyState
                  icon={Bug}
                  title="No runs yet"
                  description="Rerun from the Debugger with a session id to record runs here."
                  size="sm"
                  variant="plain"
                  action={
                    <Button size="sm" asChild variant="outline">
                      <Link href="/traces?view=debug">Open debugger</Link>
                    </Button>
                  }
                />
              ) : (
                <ul className="divide-y divide-[var(--border-subtle)] rounded-lg border border-[var(--border-subtle)]">
                  {session.runs.map((run) => (
                    <li key={run.id}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-start gap-3 px-3 py-2.5 text-xs transition-colors min-h-11",
                          selected.includes(run.id)
                            ? "bg-[var(--accent-faint)]"
                            : "hover:bg-[var(--bg-tertiary)]/50",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selected.includes(run.id)}
                          onChange={() => toggleRun(run.id)}
                          aria-label={`Select run ${run.id}`}
                        />
                        <div className="min-w-0 flex-1 font-mono">
                          <div>
                            step {run.from_step} · {run.rerun_mode} ·{" "}
                            <Link
                              href={traceHref(run.source_trace_id)}
                              className="text-[var(--accent)] hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {run.source_trace_id}
                            </Link>
                          </div>
                          <div className="mt-1 text-[var(--text-muted)]">
                            {run.diff_summary?.length ?? 0} diff steps
                            {run.created_at
                              ? ` · ${new Date(run.created_at).toLocaleString()}`
                              : ""}
                          </div>
                        </div>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>

            <TabsContent value="compare" className="mt-3">
              {compare ? (
                <pre className="overflow-auto rounded-lg bg-[var(--bg-secondary)] p-3 font-mono text-xs">
                  {JSON.stringify(compare, null, 2)}
                </pre>
              ) : (
                <EmptyState
                  icon={GitCompare}
                  title="Select two runs"
                  description="Check two runs in Runs mode, then Compare selected."
                  size="sm"
                  variant="plain"
                  action={
                    <Button size="sm" variant="outline" onClick={() => setMode("runs")}>
                      Back to Runs
                    </Button>
                  }
                />
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}
    </PageContent>
  );
}
