"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bug, Loader2, Plus } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { debugSessionsApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useToast } from "@/components/ui/toast";
import { traceHref } from "@/lib/portal-cross-links";

type DebugSessionRow = {
  id: string;
  title: string;
  source_trace_id?: string | null;
  run_count?: number;
  updated_at?: string;
};

export default function DebuggerSessionsPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const [sessions, setSessions] = useState<DebugSessionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    try {
      const res = await debugSessionsApi.list(currentOrg.id);
      setSessions(res.sessions ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async () => {
    if (!currentOrg?.id) return;
    try {
      const res = await debugSessionsApi.create(currentOrg.id, {
        title: "New debug session",
      });
      const id = res.session?.id;
      if (id) window.location.href = `/debugger-sessions/${id}`;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    }
  };

  if (!currentOrg) return <NoOrgState feature="Debugger sessions" icon={Bug} />;

  return (
    <CoreResourcePage
      header={
        <PageHeader
          title="Debugger sessions"
          subtitle="Multi-run iteration timeline — compare reruns from the same investigation."
          actions={
            <Button size="sm" onClick={() => void onCreate()}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New session
            </Button>
          }
        />
      }
      table={
        <Card className="p-2">
          {loading ? (
            <div className="flex items-center justify-center p-8 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
            </div>
          ) : sessions.length === 0 ? (
            <EmptyState
              icon={Bug}
              title="No debugger sessions yet"
              description="Start from a trace in the Debugger tab or create a session to compare prefix reruns."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button size="sm" asChild>
                    <Link href="/traces?view=debug">Open debugger</Link>
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void onCreate()}>
                    New session
                  </Button>
                </div>
              }
            />
          ) : (
            <ul className="divide-y divide-[var(--border-default)]">
              {sessions.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/debugger-sessions/${s.id}`}
                    className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-[var(--bg-secondary)]"
                  >
                    <div>
                      <div className="font-medium text-sm">{s.title}</div>
                      <div className="text-xs text-[var(--text-muted)]">
                        {s.run_count ?? 0} runs
                        {s.source_trace_id ? (
                          <>
                            {" · "}
                            <span
                              className="text-[var(--accent)]"
                              onClick={(e) => {
                                e.preventDefault();
                                window.location.href = traceHref(s.source_trace_id!);
                              }}
                            >
                              source trace
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    {s.updated_at ? (
                      <span className="text-xs text-[var(--text-muted)]">
                        {new Date(s.updated_at).toLocaleString()}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      }
    />
  );
}
