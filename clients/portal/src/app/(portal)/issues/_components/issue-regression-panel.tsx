"use client";

import { Database, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";

export function IssueRegressionPanel({
  cases,
  caseId,
  onSave,
  busy,
  error,
  onRetry,
}: {
  cases: Record<string, unknown>[];
  caseId?: string | null;
  onSave: () => void;
  busy: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  if (error) {
    return (
      <ErrorState
        size="sm"
        title="Regression memory unavailable"
        message={error}
        action={
          onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Database className="h-4 w-4" /> Regression memory (D7)
        </h2>
        <Button size="sm" variant="outline" disabled={busy} onClick={onSave}>
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Pin case"}
        </Button>
      </div>
      {caseId ? (
        <p className="mb-2 font-mono text-xs text-[var(--text-muted)]">Linked case: {caseId}</p>
      ) : (
        <p className="mb-2 text-xs text-[var(--text-muted)]">
          No permanent regression case yet — pin one before resolve to gate future canaries.
        </p>
      )}
      {cases.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">No cases materialized for this issue.</p>
      ) : (
        <ul className="space-y-1 font-mono text-xs">
          {cases.map((c) => (
            <li key={String(c.id)} className="text-[var(--text-secondary)]">
              {String(c.id)} · trace {String(c.source_trace_id ?? "—")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
