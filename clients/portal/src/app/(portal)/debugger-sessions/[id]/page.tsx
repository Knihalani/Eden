"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, GitCompare, Loader2 } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { debugSessionsApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageContent } from "@/components/layout/page-content";
import { useToast } from "@/components/ui/toast";

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

export default function DebuggerSessionDetailPage() {
  const { currentOrg } = useOrg();
  const params = useParams<{ id: string }>();
  const sessionId = params?.id;
  const toast = useToast();
  const [session, setSession] = useState<DebugSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [compare, setCompare] = useState<Record<string, unknown> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!currentOrg?.id || !sessionId) return;
    setLoading(true);
    try {
      const res = await debugSessionsApi.get(currentOrg.id, sessionId);
      setSession(
        res.session
          ? { ...res.session, runs: (res.session.runs ?? []) as DebugRun[] }
          : null,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, sessionId, toast]);

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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Compare failed");
    }
  };

  if (!currentOrg) return null;

  return (
    <PageContent size="wide">
      <Link
        href="/debugger-sessions"
        className="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> All sessions
      </Link>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading session…
        </div>
      ) : !session ? (
        <p className="text-sm text-[var(--text-muted)]">Session not found.</p>
      ) : (
        <div className="space-y-4">
          <div>
            <h1 className="text-lg font-semibold">{session.title}</h1>
            {session.source_trace_id && (
              <p className="text-xs font-mono text-[var(--text-muted)] mt-1">
                source trace: {session.source_trace_id}
              </p>
            )}
          </div>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold">Runs ({session.runs.length})</h2>
              <Button
                size="sm"
                variant="outline"
                disabled={selected.length !== 2}
                onClick={() => void onCompare()}
              >
                <GitCompare className="h-3.5 w-3.5 mr-1" /> Compare selected
              </Button>
            </div>
            {session.runs.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">
                Rerun from the Debugger tab with a session id to record runs here.
              </p>
            ) : (
              <ul className="space-y-2">
                {session.runs.map((run) => (
                  <li
                    key={run.id}
                    className="flex items-start gap-3 rounded border border-[var(--border-subtle)] p-3 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(run.id)}
                      onChange={() => toggleRun(run.id)}
                      aria-label={`Select run ${run.id}`}
                    />
                    <div className="flex-1 font-mono">
                      <div>
                        step {run.from_step} · {run.rerun_mode} · {run.source_trace_id}
                      </div>
                      <div className="text-[var(--text-muted)] mt-1">
                        {run.diff_summary?.length ?? 0} diff steps
                        {run.created_at ? ` · ${new Date(run.created_at).toLocaleString()}` : ""}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {compare && (
            <Card className="p-4">
              <h3 className="text-sm font-semibold mb-2">Run comparison</h3>
              <pre className="text-[11px] font-mono overflow-auto bg-[var(--bg-tertiary)] p-3 rounded">
                {JSON.stringify(compare, null, 2)}
              </pre>
            </Card>
          )}
        </div>
      )}
    </PageContent>
  );
}
