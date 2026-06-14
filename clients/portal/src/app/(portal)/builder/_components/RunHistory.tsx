"use client";

/**
 * RunHistory — collapsible list of past sim runs for the
 * current agent. Polls ``agentsApi.listSimRuns`` on mount and
 * on-demand via the refresh button. Click a row to open the
 * run in the dialog (read-only).
 *
 * Only renders when the user has an agent_id cached for the
 * current graph name. The "Push & Run" path is the one that
 * mints agent_ids; before the first push, the panel shows a
 * "Push & Run first" hint.
 */

import { useCallback, useEffect, useState } from "react";
import { History, Loader2, RefreshCw, X } from "lucide-react";

import { agentsApi } from "@/lib/api";
import type { SimRun } from "@/lib/api";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import { lookupAgentId } from "../_lib/storage";

export interface RunHistoryProps {
  graphName: string;
  onOpenRun: (run: SimRun, agentId: string) => void;
  /** Bump counter from parent (e.g. after a new push) to
   *  force a re-fetch. */
  refreshKey?: number;
}

const STATUS_COLOR: Record<string, string> = {
  passed: "text-[var(--terminal)]",
  failed: "text-[var(--warning)]",
  error: "text-[var(--error)]",
  pending: "text-[var(--text-muted)]",
  running: "text-[var(--accent)]",
};

export function RunHistory({
  graphName,
  onOpenRun,
  refreshKey,
}: RunHistoryProps) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const toast = useToast();

  const [agentId, setAgentId] = useState<string | null>(null);
  const [runs, setRuns] = useState<SimRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);

  // Re-resolve the agent_id on mount and whenever refreshKey
  // changes. agentId is keyed by graphName in localStorage.
  useEffect(() => {
    setAgentId(lookupAgentId(graphName));
  }, [graphName, refreshKey]);

  const fetch = useCallback(async () => {
    if (!orgId || !agentId) return;
    setLoading(true);
    try {
      const result = await agentsApi.listSimRuns(orgId, agentId, {
        limit: 10,
      });
      setRuns(result.runs);
    } catch (err) {
      toast.error(`Failed to load runs: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [orgId, agentId, toast]);

  useEffect(() => {
    void fetch();
  }, [fetch, refreshKey]);

  if (!agentId) {
    return (
      <div className="border-t border-[var(--border-default)] p-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
          <History className="w-3 h-3" />
          Run history
        </h3>
        <p className="text-[11px] text-[var(--text-muted)] mt-1.5">
          Push &amp; Run once to register an agent and start collecting
          run history.
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-[var(--border-default)] p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left"
        aria-expanded={open}
      >
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
          <History className="w-3 h-3" />
          Run history ({runs.length})
        </h3>
        <span className="text-[10px] text-[var(--text-muted)]">
          agent {agentId.slice(0, 12)}…
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {loading && runs.length === 0 ? (
            <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
              <Loader2 className="w-3 h-3 animate-spin" />
              Loading…
            </div>
          ) : runs.length === 0 ? (
            <p className="text-[11px] text-[var(--text-muted)]">
              No runs yet.
            </p>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onOpenRun(r, agentId)}
                className="w-full text-left rounded border border-[var(--border-subtle)] bg-[var(--bg-secondary)] hover:border-[var(--accent)] px-2 py-1.5 flex items-center justify-between gap-2"
                data-testid={`run-row-${r.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "text-[10px] font-medium",
                        STATUS_COLOR[r.status] ?? STATUS_COLOR.pending,
                      )}
                    >
                      {r.status}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {new Date(r.started_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">
                    {r.id}
                  </div>
                </div>
                {r.duration_ms != null && (
                  <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                    {r.duration_ms}ms
                  </span>
                )}
              </button>
            ))
          )}
          <button
            type="button"
            onClick={fetch}
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1 mt-1"
            aria-label="Refresh run history"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}

// Suppress unused-import warning for X (kept for future use).
void X;
