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
}

const STATUS_COLOR: Record<string, string> = {
  passed: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  failed: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  error: "text-red-400 border-red-500/30 bg-red-500/10",
  pending: "text-zinc-400 border-zinc-500/30 bg-zinc-500/10",
  running: "text-sky-400 border-sky-500/30 bg-sky-500/10",
};

export function RunResultsDialog({ state, onClose, orgId }: RunResultsDialogProps) {
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="Sim run results"
    >
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-100">
            {state.kind === "pushing" && "Pushing to Eden…"}
            {state.kind === "polling" && `Running… (${state.run.status})`}
            {state.kind === "done" && `Run ${state.run.status}`}
            {state.kind === "error" && "Error"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-100 rounded"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {state.kind === "pushing" && (
            <div className="flex items-center gap-2 text-sm text-zinc-300">
              <Loader2 className="w-4 h-4 animate-spin" />
              Packaging the tarball and uploading…
            </div>
          )}
          {state.kind === "polling" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-zinc-300">
                <Loader2 className="w-4 h-4 animate-spin" />
                Polling <span className="font-mono">{state.run.id}</span> every
                2 s…
              </div>
              <StatusBadge status={state.run.status} />
            </div>
          )}
          {state.kind === "done" && <DoneView state={state} orgId={orgId} />}
          {state.kind === "error" && (
            <div className="flex items-start gap-2 text-sm text-red-300">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <p className="whitespace-pre-wrap">{state.message}</p>
            </div>
          )}
        </div>
        <footer className="px-4 py-3 border-t border-zinc-800 flex items-center justify-end gap-2">
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
  orgId,
}: {
  state: Extract<RunDialogState, { kind: "done" }>;
  orgId: string | null;
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
          <CheckCircle2 className="w-6 h-6 text-emerald-400" />
        ) : r.status === "failed" ? (
          <XCircle className="w-6 h-6 text-amber-400" />
        ) : (
          <AlertCircle className="w-6 h-6 text-red-400" />
        )}
        <div>
          <div className="text-sm font-semibold text-zinc-100">
            {r.status === "passed" ? "All scenarios passed" : r.status}
          </div>
          {summary && (
            <div className="text-xs text-zinc-400">{summary}</div>
          )}
          {r.duration_ms != null && (
            <div className="text-[11px] text-zinc-500">
              Duration: {r.duration_ms} ms
            </div>
          )}
        </div>
        <StatusBadge status={r.status} />
      </div>

      {scenarios.length > 0 && (
        <div className="rounded-md border border-zinc-800 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Scenario</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-right px-3 py-2 font-medium">Episodes</th>
                <th className="text-right px-3 py-2 font-medium">Pass</th>
                <th className="text-right px-3 py-2 font-medium">Fail</th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s, i) => (
                <tr
                  key={`${s.scenario_id}-${i}`}
                  className="border-t border-zinc-800 text-zinc-300"
                >
                  <td className="px-3 py-1.5 font-mono">{s.scenario_id}</td>
                  <td className="px-3 py-1.5">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-3 py-1.5 text-right">{s.episodes}</td>
                  <td className="px-3 py-1.5 text-right text-emerald-400">
                    {s.passed_steps}
                  </td>
                  <td className="px-3 py-1.5 text-right text-amber-400">
                    {s.failed_steps}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {r.error && (
        <pre className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-[11px] text-red-200 font-mono whitespace-pre-wrap">
          {r.error}
        </pre>
      )}

      {orgId && (
        <a
          href={`/agents/${state.agentId}?org=${orgId}`}
          className="text-[11px] text-emerald-400 hover:text-emerald-300 underline"
        >
          View in agent detail page →
        </a>
      )}
    </div>
  );
}
