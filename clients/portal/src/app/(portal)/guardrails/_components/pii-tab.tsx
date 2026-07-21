"use client";

import { ErrorState } from "@/components/ui/error-state";
import { DataTable } from "@/components/ui/data-table";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import {
  FEATURE_NOT_ENABLED_MESSAGE,
  FEATURE_NOT_ENABLED_TITLE,
  NOT_IMPLEMENTED_MESSAGE,
  NOT_IMPLEMENTED_TITLE,
} from "@/lib/feature-flag-error";
import { FileLock2, History, Lock } from "lucide-react";

export function PiiTab({
  history,
  unavailable = false,
  error = "",
  onRetry,
}: {
  history: Array<{
    id: string;
    trace_id: string | null;
    verdict: string;
    reason: string | null;
    edited_text: string | null;
    created_at: string;
  }>;
  unavailable?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  const totalCategories = history.reduce<Record<string, number>>((acc, r) => {
    if (!r.reason) return acc;
    // Heuristic: try to extract category from "pii: <category> detected" reason
    const m = r.reason.match(/pii:\s*([\w-]+)/i);
    if (m) {
      acc[m[1]] = (acc[m[1]] || 0) + 1;
    }
    return acc;
  }, {});
  return <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <FileLock2 className="w-4 h-4 text-[var(--warning)]" />
            PII redaction log
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Recent redactions performed by the PII policy
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <History className="w-3.5 h-3.5" />
          Last 24h
        </div>
      </div>

      {unavailable ? (
        <ErrorState
          title={
            error === FEATURE_NOT_ENABLED_TITLE
              ? FEATURE_NOT_ENABLED_TITLE
              : error === NOT_IMPLEMENTED_TITLE
                ? NOT_IMPLEMENTED_TITLE
                : "Could not load PII history"
          }
          message={
            error === FEATURE_NOT_ENABLED_TITLE
              ? FEATURE_NOT_ENABLED_MESSAGE
              : error === NOT_IMPLEMENTED_TITLE
                ? NOT_IMPLEMENTED_MESSAGE
                : error || "Could not load PII history."
          }
          action={
            onRetry &&
            error !== FEATURE_NOT_ENABLED_TITLE &&
            error !== NOT_IMPLEMENTED_TITLE ? (
              <Button className="min-h-11" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {!unavailable && <>
      {/* Category rollup strip — thin KPI, hard-capped */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-2">
        {Object.entries(totalCategories).slice(0, 7).map(([cat, count]) => (
          <Panel key={cat} tone="flat" padding="sm">
            <p className="text-2xs uppercase tracking-wider text-[var(--text-muted)] font-semibold font-mono">
              {cat.replace(/_/g, " ")}
            </p>
            <p className="text-lg font-bold text-[var(--warning)] tabular-nums mt-space-1">
              {count}
            </p>
          </Panel>
        ))}
      </div>

      <DataTable columns={[{
        key: "created_at",
        header: "When",
        sortable: true,
        cell: r => <span className="text-xs text-[var(--text-muted)] whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</span>
      }, {
        key: "edited_text",
        header: "Content preview",
        cell: r => <code className="text-xs font-mono text-[var(--text-primary)] bg-[var(--bg-secondary)] px-2 py-1 rounded inline-block max-w-full truncate">
                  {r.edited_text ?? r.reason ?? "—"}
                </code>
      }, {
        key: "reason",
        header: "Categories",
        cell: r => {
          const cat = r.reason?.match(/^pii:\s*([\w-]+)/i)?.[1] ?? "pii";
          return <span className="inline-flex items-center gap-1 text-2xs uppercase tracking-wider font-semibold px-1.5 py-1 rounded bg-[var(--warning-bg)] text-[var(--warning)]">
                    {cat.replace(/_/g, " ")}
                  </span>;
        }
      }]} rows={history} rowKey={r => r.id} defaultSort={{
        key: "created_at",
        direction: "desc"
      }} emptyTitle="No PII redactions recorded yet" emptyDescription="Run a redact in the Test tab to populate this log." emptyIcon={Lock} pageSize={25} />

      <Panel tone="inset" padding="sm" className="text-xs text-[var(--text-muted)] flex items-start gap-2">
        <Lock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-[var(--accent)]" />
        <p>
          Redactions are irreversible at write time. Configure the PII policy under Settings →
          Compliance to customize which categories are masked.
        </p>
      </Panel>
      </>}
    </div>;
}
