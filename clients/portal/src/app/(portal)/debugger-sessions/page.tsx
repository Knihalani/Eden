"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bug, Loader2, Plus } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { debugSessionsApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
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
  const router = useRouter();
  const toast = useToast();
  const [sessions, setSessions] = useState<DebugSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentOrg?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await debugSessionsApi.list(currentOrg.id);
      setSessions(res.sessions ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load sessions";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

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
      if (id) router.push(`/debugger-sessions/${id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    }
  };

  if (!currentOrg) return <NoOrgState feature="Debug sessions" icon={Bug} />;

  return (
    <CoreResourcePage
      header={
        <PageHeader
          title="Debug sessions"
          subtitle="Multi-run iteration timeline — compare reruns from the same investigation."
          actions={
            <Button size="sm" onClick={() => void onCreate()}>
              <Plus className="h-3.5 w-3.5" /> New session
            </Button>
          }
        />
      }
      table={
        error ? (
          <ErrorState
            title="Could not load sessions"
            message={error}
            action={
              <Button variant="outline" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        ) : loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={Bug}
            title="No debugger sessions yet"
            description="Start from a trace in the Debugger or create a session to compare prefix reruns."
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
          <ul className="divide-y divide-[var(--border-subtle)] rounded-xl bg-[var(--bg-secondary)] overflow-hidden">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/debugger-sessions/${s.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-[var(--bg-tertiary)]/50 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-[var(--text-primary)] truncate">
                      {s.title}
                    </div>
                    <div className="text-xs text-[var(--text-muted)]">
                      {s.run_count ?? 0} runs
                      {s.source_trace_id ? (
                        <>
                          {" · "}
                          <span
                            role="link"
                            tabIndex={0}
                            className="text-[var(--accent)] hover:underline cursor-pointer"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              router.push(traceHref(s.source_trace_id!));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                router.push(traceHref(s.source_trace_id!));
                              }
                            }}
                          >
                            source trace
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  {s.updated_at ? (
                    <span className="text-xs text-[var(--text-muted)] shrink-0">
                      {new Date(s.updated_at).toLocaleString()}
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )
      }
    />
  );
}
