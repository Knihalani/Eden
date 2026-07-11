"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { closedLoopApi, type ClosedLoopAction } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { Check, X, Play, AlertCircle, Loader2, Inbox, History, BarChart3, Repeat } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Card } from "@/components/ui/card";
type Action = {
  action_id: string;
  hook: string;
  status: string;
  created_at: string;
  payload: Record<string, unknown>;
};
type Dashboard = {
  pending: number;
  approved: number;
  denied: number;
  applied: number;
  by_hook: Record<string, number>;
  by_status: Record<string, number>;
  by_severity: Record<string, number>;
};

function mapClosedLoopAction(row: ClosedLoopAction): Action {
  const status =
    row.status === "pending_approval"
      ? "pending"
      : row.status;
  return {
    action_id: row.id,
    hook: row.hook_name || row.action_kind,
    status,
    created_at: row.created_at,
    payload: row.payload ?? {},
  };
}

function mapDashboard(data: {
  total: number;
  by_kind: Record<string, number>;
  by_status: Record<string, number>;
  by_severity: Record<string, number>;
}): Dashboard {
  const byStatus = data.by_status ?? {};
  return {
    pending: byStatus.pending_approval ?? 0,
    approved: byStatus.approved ?? 0,
    denied: byStatus.denied ?? 0,
    applied: byStatus.applied ?? 0,
    by_hook: data.by_kind ?? {},
    by_status: byStatus,
    by_severity: data.by_severity ?? {},
  };
}
export default function ClosedLoopPage() {
  const {
    currentOrg
  } = useOrg();
  const toast = useToast();
  const {
    confirm,
    ConfirmDialog
  } = useConfirm();
  const [tab, setTab] = useState<"pending" | "history" | "dashboard">("pending");
  const [pending, setPending] = useState<Action[]>([]);
  const [history, setHistory] = useState<Action[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const loadAll = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const [pendingRes, allRes, dashRes] = await Promise.all([
        closedLoopApi.listPending(currentOrg.id).catch(() => ({ data: { actions: [] } })),
        closedLoopApi.listAll(currentOrg.id).catch(() => ({ data: { actions: [] } })),
        closedLoopApi.dashboard(currentOrg.id).catch(() => null),
      ]);
      setPending((pendingRes.data?.actions ?? []).map(mapClosedLoopAction));
      setHistory((allRes.data?.actions ?? []).map(mapClosedLoopAction));
      setDashboard(dashRes?.data ? mapDashboard(dashRes.data) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load closed-loop actions");
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);
  useEffect(() => {
    loadAll();
  }, [loadAll]);
  const handleApprove = async (actionId: string) => {
    if (!currentOrg) return;
    setBusyActionId(actionId);
    try {
      await closedLoopApi.approveAction(currentOrg.id, actionId);
      toast.success("Action approved");
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setBusyActionId(null);
    }
  };
  const handleDeny = async (actionId: string) => {
    if (!currentOrg) return;
    // ponytail: window.prompt retained as a minimal-but-native way to
    // collect a denial reason. A styled modal is the proper fix; defer
    // until a reason input is needed in more than one place.
    const reason = window.prompt("Optional reason for denial:") ?? undefined;
    setBusyActionId(actionId);
    try {
      await closedLoopApi.denyAction(currentOrg.id, actionId, {
        reason
      });
      toast.success("Action denied");
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to deny");
    } finally {
      setBusyActionId(null);
    }
  };
  const handleApply = async (actionId: string) => {
    if (!currentOrg) return;
    const ok = await confirm({
      title: "Apply this action?",
      description: "This will execute the underlying change. Are you sure?",
      confirmLabel: "Apply",
      variant: "destructive"
    });
    if (!ok) return;
    setBusyActionId(actionId);
    try {
      await closedLoopApi.applyAction(currentOrg.id, actionId);
      toast.success("Action applied");
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to apply");
    } finally {
      setBusyActionId(null);
    }
  };
  if (!currentOrg) {
    return <NoOrgState feature="Closed-Loop Actions" icon={Inbox} description="Select an organization to review automated promotion recommendations" />;
  }
  return <PageContent size="default">
      <PageHeader title="Closed-Loop Actions" subtitle="Review and act on automated recommendations from the promotion loop, judge regressions, drift alerts, and experiment winners." icon={Inbox} />

      {/* Dashboard summary cards */}
      {dashboard && <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <SummaryCard label="Pending" value={dashboard.pending} icon={Inbox} />
          <SummaryCard label="Approved" value={dashboard.approved} icon={Check} />
          <SummaryCard label="Denied" value={dashboard.denied} icon={X} />
          <SummaryCard label="Applied" value={dashboard.applied} icon={Play} />
        </div>}

      {/* Tab strip */}
      <div role="tablist" aria-label="Closed-loop views" className="flex items-center gap-1 mb-4 border-b border-[var(--border-default)]">
        <TabButton active={tab === "pending"} onClick={() => setTab("pending")} icon={Inbox} ariaLabel={`Pending actions (${pending.length})`}>
          Pending ({pending.length})
        </TabButton>
        <TabButton active={tab === "history"} onClick={() => setTab("history")} icon={History} ariaLabel="Action history">
          History
        </TabButton>
        <TabButton active={tab === "dashboard"} onClick={() => setTab("dashboard")} icon={BarChart3} ariaLabel="Action dashboard">
          Dashboard
        </TabButton>
      </div>

      {error && <div role="alert" className="mb-4 flex items-start justify-between gap-2 rounded-lg border border-[var(--error)] bg-[var(--error-bg)] p-3 text-sm text-[var(--error)]">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Failed to load actions</p>
              <p className="text-xs mt-1 opacity-80">{error}</p>
            </div>
          </div>
          <button onClick={loadAll} disabled={loading} className="text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50 shrink-0">
            Retry
          </button>
        </div>}

      {loading ? <div role="status" aria-live="polite" aria-busy="true" className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
        </div> : tab === "pending" ? <ActionList actions={pending} busyActionId={busyActionId} onApprove={handleApprove} onDeny={handleDeny} onApply={handleApply} emptyMessage="No pending actions — the promotion loop is up to date." /> : tab === "history" ? <ActionList actions={history} readOnly emptyMessage="No historical actions yet." /> : <DashboardView dashboard={dashboard} />}
      {ConfirmDialog}
    </PageContent>;
}
function SummaryCard({
  label,
  value,
  icon: Icon
}: {
  label: string;
  value: number;
  icon: typeof Inbox;
}) {
  return <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
          <p className="text-2xl font-bold text-[var(--text-primary)] mt-1">{value}</p>
        </div>
        <Icon className="h-5 w-5 text-[var(--text-muted)]" />
      </div>
    </div>;
}
function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
  ariaLabel
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Inbox;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  return <button onClick={onClick} role="tab" aria-selected={active} aria-label={ariaLabel} className={cn("flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors", active ? "border-[var(--accent)] text-[var(--text-primary)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]")}>
      <Icon className="h-4 w-4" />
      {children}
    </button>;
}
function ActionList({
  actions,
  busyActionId,
  onApprove,
  onDeny,
  onApply,
  readOnly,
  emptyMessage
}: {
  actions: Action[];
  busyActionId?: string | null;
  onApprove?: (id: string) => void;
  onDeny?: (id: string) => void;
  onApply?: (id: string) => void;
  readOnly?: boolean;
  emptyMessage: string;
}) {
  if (actions.length === 0) {
    return <Card padding="lg" className="-dashed">
        <EmptyState icon={Inbox} title={emptyMessage} description="Actions will appear here once the promotion loop fires" />
      </Card>;
  }
  return <div className="space-y-3">
      {actions.map(a => {
      const issueId = typeof a.payload?.issue_id === "string" ? a.payload.issue_id : null;
      const repeat = typeof a.payload?.repetition_count === "number" ? a.payload.repetition_count : 0;
      return <div key={a.action_id} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                  {a.hook}
                </span>
                <StatusBadge status={a.status} />
                {issueId && <Link href={`/issues/${issueId}`} className="text-xs font-medium text-[var(--accent)] hover:underline">
                  View issue →
                </Link>}
                {repeat > 1 && <span title={`Re-occurred ${repeat} times`} className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-[var(--error)]/10 text-[var(--error)] border-[var(--error)]/30">
                  <Repeat className="h-3 w-3" />×{repeat}
                </span>}
                <span className="text-xs text-[var(--text-muted)]">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </div>
              <p className="mt-2 text-xs font-mono text-[var(--text-muted)] break-all">
                {a.action_id}
              </p>
              {a.payload && Object.keys(a.payload).length > 0 && <pre className="mt-2 p-2 rounded bg-[var(--bg-tertiary)] text-[11px] font-mono text-[var(--text-secondary)] overflow-x-auto">
                  {JSON.stringify(a.payload, null, 2)}
                </pre>}
            </div>
            {!readOnly && onApprove && onDeny && <div className="flex flex-col gap-2 shrink-0">
                <Button size="sm" variant="default" disabled={busyActionId === a.action_id} onClick={() => onApprove(a.action_id)}>
                  <Check className="h-3 w-3 mr-1" /> Approve
                </Button>
                <Button size="sm" variant="outline" disabled={busyActionId === a.action_id} onClick={() => onDeny(a.action_id)}>
                  <X className="h-3 w-3 mr-1" /> Deny
                </Button>
                {onApply && a.status === "approved" && <Button size="sm" variant="secondary" disabled={busyActionId === a.action_id} onClick={() => onApply(a.action_id)}>
                    <Play className="h-3 w-3 mr-1" /> Apply
                  </Button>}
              </div>}
          </div>
        </div>;
    })}
    </div>;
}
function StatusBadge({
  status
}: {
  status: string;
}) {
  const colorMap: Record<string, string> = {
    pending: "bg-[var(--warning)]/20 text-[var(--warning)] border-[var(--warning)]/30",
    approved: "bg-[var(--terminal)]/20 text-[var(--terminal)] border-[var(--terminal)]/30",
    denied: "bg-[var(--error)]/20 text-[var(--error)] border-[var(--error)]/30",
    applied: "bg-[var(--accent)]/20 text-[var(--accent)] border-[var(--accent)]/30"
  };
  return <span className={cn("inline-flex items-center text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border", colorMap[status] ?? "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-subtle)]")}>
      {status}
    </span>;
}
function DashboardView({
  dashboard
}: {
  dashboard: Dashboard | null;
}) {
  if (!dashboard) {
    return <div className="rounded-lg border border-dashed border-[var(--border-default)] bg-[var(--bg-primary)] p-12 text-center text-sm text-[var(--text-muted)]">
        Dashboard data unavailable.
      </div>;
  }
  return <div className="space-y-4">
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Actions by hook</h3>
        {Object.keys(dashboard.by_hook).length === 0 ? <p className="text-sm text-[var(--text-muted)]">No actions recorded yet.</p> : <ul className="space-y-2">
            {Object.entries(dashboard.by_hook).sort(([, a], [, b]) => b - a).map(([hook, count]) => <li key={hook} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-[var(--text-secondary)]">{hook}</span>
                  <span className="text-[var(--text-muted)]">{count}</span>
                </li>)}
          </ul>}
      </div>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Actions by status</h3>
        {Object.keys(dashboard.by_status).length === 0 ? <p className="text-sm text-[var(--text-muted)]">No status breakdown yet.</p> : <ul className="space-y-2">
            {Object.entries(dashboard.by_status).sort(([, a], [, b]) => b - a).map(([status, count]) => <li key={status} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-[var(--text-secondary)]">{status}</span>
                  <span className="text-[var(--text-muted)]">{count}</span>
                </li>)}
          </ul>}
      </div>
    </div>;
}