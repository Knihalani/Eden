"use client";

import { cn } from "@/lib/utils";
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
import {
  Shield,
  Bug,
  AlertTriangle,
  AlertOctagon,
  History,
} from "lucide-react";
import { SEVERITY_STYLES } from "./types";

export function InjectionsTab({
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
    created_at: string;
  }>;
  unavailable?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  return <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Bug className="w-4 h-4 text-[var(--error)]" />
            Recent injection attempts
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Live feed of prompt-injection probes detected by the gateway
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
                : "Could not load injection history"
          }
          message={
            error === FEATURE_NOT_ENABLED_TITLE
              ? FEATURE_NOT_ENABLED_MESSAGE
              : error === NOT_IMPLEMENTED_TITLE
                ? NOT_IMPLEMENTED_MESSAGE
                : error || "Could not load injection history."
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

      {!unavailable && <DataTable columns={[{
        key: "verdict",
        header: "Severity",
        sortable: true,
        cell: inj => {
          const sev = inj.verdict === "block" ? SEVERITY_STYLES["high"] : SEVERITY_STYLES[inj.verdict] ?? SEVERITY_STYLES["low"];
          return <span className={cn("inline-flex items-center gap-1 text-2xs uppercase tracking-wider font-bold px-1.5 py-1 rounded", sev.chip)}>
                    {sev.icon === "high" ? <AlertOctagon className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                    {inj.verdict}
                  </span>;
        }
      }, {
        key: "reason",
        header: "Pattern",
        cell: inj => <code className="text-xs font-mono text-[var(--text-primary)] break-all">{inj.reason ?? "—"}</code>
      }, {
        key: "trace_id",
        header: "Source",
        cell: inj => <span className="text-2xs uppercase tracking-wider font-semibold px-2 py-1 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                  {inj.trace_id ? inj.trace_id.slice(0, 12) : "—"}
                </span>
      }, {
        key: "reason_snippet",
        header: "Snippet",
        cell: inj => <p className="text-xs text-[var(--text-muted)] truncate max-w-[420px]" title={inj.reason ?? ""}>
                  {inj.reason ?? "—"}
                </p>
      }, {
        key: "created_at",
        header: "When",
        sortable: true,
        cell: inj => <span className="text-xs text-[var(--text-muted)] whitespace-nowrap">{new Date(inj.created_at).toLocaleString()}</span>
      }]} rows={history} rowKey={inj => inj.id} defaultSort={{
        key: "created_at",
        direction: "desc"
      }} emptyTitle="No injection attempts recorded yet" emptyDescription="Run a scan in the Test tab to populate this log." emptyIcon={Shield} pageSize={25} />}

      {!unavailable && <Panel tone="inset" padding="sm" className="text-xs text-[var(--text-muted)] flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-[var(--warning)]" />
        <p>
          Each scan in the Test tab writes a new attempt to this log automatically.
        </p>
      </Panel>}
    </div>;
}
