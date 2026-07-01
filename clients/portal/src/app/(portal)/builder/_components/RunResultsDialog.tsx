/**
 * RunResultsDialog — modal that shows the in-flight / final
 * status of a sim run triggered by the "Push & Run" button.
 * Polling lives in useBuilderState; this component is purely
 * a view over the run state.
 */

"use client";

import { useEffect } from "react";
import { CheckCircle2, Loader2, XCircle, AlertCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import type { SimRun } from "@/lib/api";

export type RunDialogState =
  | { kind: "idle" }
  | { kind: "pushing" }
  | {
      kind: "polling";
      run: SimRun;
      agentId: string;
    }
  | {
      kind: "done";
      run: SimRun;
      agentId: string;
    }
  | { kind: "error"; message: string };

export interface RunResultsDialogProps {
  state: RunDialogState;
  onClose: () => void;
  orgId: string | null;
  onRerun?: (run: SimRun, agentId: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  passed: "text-[var(--terminal)] border-emerald-500/30 bg-[var(--terminal)]/10",
  failed: "text-[var(--warning)] border-[var(--warning)]/30 bg-[var(--warning)]/10",
  error: "text-[var(--error)] border-[var(--error)]/30 bg-[var(--error)]/10",
  pending: "text-[var(--text-muted)] border-[var(--border-default)] bg-[var(--bg-elev-1)]",
  running: "text-[var(--accent)] border-sky-500/30 bg-[var(--accent)]/10" };

export function RunResultsDialog({ state, onClose, orgId, onRerun }: RunResultsDialogProps) {
  // Close on Escape
  useEffect(() => {
    if (state.kind === "idle") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.kind, onClose]);

  if (state.kind === "idle") return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--bg-base)]/50"
      role="dialog"
      aria-modal="true"
      aria-label="Sim run results"
    >
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-base)] shadow-2xl">
        <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {state.kind === "pushing" && "Pushing to Eden…"}
            {state.kind === "polling" && `Running… (${state.run.status})`}
            {state.kind === "done" && `Run ${state.run.status}`}
            {state.kind === "error" && "Error"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {state.kind === "pushing" && (
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <Loader2 className="w-4 h-4 animate-spin" />
              Packaging the tarball and uploading…
            </div>
          )}
          {state.kind === "polling" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <Loader2 className="w-4 h-4 animate-spin" />
                Polling <span className="font-mono">{state.run.id}</span> every
                2 s…
              </div>
              <StatusBadge status={state.run.status} />
            </div>
          )}
          {state.kind === "done" && (
            <DoneView
              state={state}
              orgId={orgId}
              onRerun={onRerun ? () => onRerun(state.run, state.agentId) : undefined}
            />
          )}
          {state.kind === "error" && (
            <div className="flex items-start gap-2 text-sm text-[var(--error)]">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <p className="whitespace-pre-wrap">{state.message}</p>
            </div>
          )}
        </div>
        <footer className="px-4 py-3 border-t border-[var(--border-default)] flex items-center justify-end gap-2">
          {state.kind === "done" && onRerun && (
            <Button
              type="button"
              variant="default"
              onClick={() => onRerun(state.run, state.agentId)}
              data-testid="rerun-button"
            >
              Rerun
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </footer>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium ${STATUS_COLOR[status] ?? STATUS_COLOR.pending}`}
    >
      {status}
    </span>
  );
}

function DoneView({
  state,
  orgId }: {
  state: Extract<RunDialogState, { kind: "done" }>;
  orgId: string | null;
  onRerun?: () => void;
}) {
  const r = state.run;
  const scenarios = (
    (r.results as { scenarios?: Array<Record<string, unknown>> } | null)
      ?.scenarios ?? []
  ) as Array<{
    scenario_id: string;
    status: string;
    episodes: number;
    passed_steps: number;
    failed_steps: number;
    error?: string;
  }>;
  const summary = (r.results as { summary?: string } | null)?.summary;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        {r.status === "passed" ? (
          <CheckCircle2 className="w-6 h-6 text-[var(--terminal)]" />
        ) : r.status === "failed" ? (
          <XCircle className="w-6 h-6 text-[var(--warning)]" />
        ) : (
          <AlertCircle className="w-6 h-6 text-[var(--error)]" />
        )}
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">
            {r.status === "passed" ? "All scenarios passed" : r.status}
          </div>
          {summary && (
            <div className="text-xs text-[var(--text-muted)]">{summary}</div>
          )}
          {r.duration_ms != null && (
            <div className="text-[11px] text-[var(--text-muted)]">
              Duration: {r.duration_ms} ms
            </div>
          )}
        </div>
        <StatusBadge status={r.status} />
      </div>

      {scenarios.length > 0 && (
        <div className="rounded-md border border-[var(--border-default)] overflow-hidden">
          <DataTable
            columns={[
              { key: "scenario_id", header: "Scenario", cell: (s) => <span className="font-mono">{s.scenario_id}</span> },
              { key: "status", header: "Status", cell: (s) => <StatusBadge status={s.status} /> },
              { key: "episodes", header: "Episodes", sortable: true, align: "right", cell: (s) => s.episodes },
              { key: "passed_steps", header: "Pass", sortable: true, align: "right", cell: (s) => <span className="text-[var(--terminal)]">{s.passed_steps}</span> },
              { key: "failed_steps", header: "Fail", sortable: true, align: "right", cell: (s) => <span className="text-[var(--warning)]">{s.failed_steps}</span> },
            ]}
            rows={scenarios}
            rowKey={(s, i) => `${s.scenario_id}-${i}`}
            defaultSort={{ key: "scenario_id", direction: "asc" }}
            pageSize={50}
          />
        </div>
      )}

      {r.error && (
        <pre className="rounded-md border border-[var(--error)]/30 bg-[var(--error)]/10 p-3 text-[11px] text-[var(--error)] font-mono whitespace-pre-wrap">
          {r.error}
        </pre>
      )}

      {orgId && (
        <a
          href={`/agents/${state.agentId}?org=${orgId}`}
          className="text-[11px] text-[var(--terminal)] hover:text-[var(--terminal)] underline"
        >
          View in agent detail page →
        </a>
      )}
    </div>
  );
}
