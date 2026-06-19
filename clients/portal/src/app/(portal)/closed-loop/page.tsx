"use client";

import { useEffect, useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { closedLoopApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/hooks/use-confirm";
import { Check, X, Play, AlertCircle, Loader2, Inbox, History, BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";

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
  applied_today: number;
  by_hook: Record<string, number>;
};

export default function ClosedLoopPage() {
  const { currentOrg } = useOrg();
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
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
        closedLoopApi.listActions(currentOrg.id, { status: "pending" }).catch(() => ({ actions: [] })),
        closedLoopApi.listActions(currentOrg.id).catch(() => ({ actions: [] })),
        closedLoopApi.dashboard(currentOrg.id).catch(() => null),
      ]);
      setPending(pendingRes.actions ?? []);
      setHistory(allRes.actions ?? []);
      setDashboard(dashRes);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load closed-loop actions");
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
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to approve");
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
      await closedLoopApi.denyAction(currentOrg.id, actionId, { reason });
      toast.success("Action denied");
      await loadAll();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to deny");
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
      variant: "destructive",
    });
    if (!ok) return;
    setBusyActionId(actionId);
    try {
      await closedLoopApi.applyAction(currentOrg.id, actionId);
      toast.success("Action applied");
      await loadAll();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to apply");
    } finally {
      setBusyActionId(null);
    }
  };

  if (!currentOrg) {
    return (
      <div className="p-6 text-sm text-[var(--text-muted)]">
        Select an organization to view closed-loop actions.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl">
      <PageHeader
        title="Closed-Loop Actions"
        subtitle="Review and act on automated recommendations from the promotion loop, judge regressions, drift alerts, and experiment winners."
        icon={Inbox}
      />

      {/* Dashboard summary cards */}
      {dashboard && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <SummaryCard label="Pending" value={dashboard.pending} icon={Inbox} />
          <SummaryCard label="Approved" value={dashboard.approved} icon={Check} />
          <SummaryCard label="Denied" value={dashboard.denied} icon={X} />
          <SummaryCard label="Applied today" value={dashboard.applied_today} icon={Play} />
        </div>
      )}

      {/* Tab strip */}
      <div className="flex items-center gap-1 mb-4 border-b border-[var(--border)]">
        <TabButton active={tab === "pending"} onClick={() => setTab("pending")} icon={Inbox}>
          Pending ({pending.length})
        </TabButton>
        <TabButton active={tab === "history"} onClick={() => setTab("history")} icon={History}>
          History
        </TabButton>
        <TabButton active={tab === "dashboard"} onClick={() => setTab("dashboard")} icon={BarChart3}>
          Dashboard
        </TabButton>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--error)] bg-[var(--error-bg)] p-3 text-sm text-[var(--error)]">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Failed to load actions</p>
            <p className="text-xs mt-1 opacity-80">{error}</p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center p-12 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
        </div>
      ) : tab === "pending" ? (
        <ActionList
          actions={pending}
          busyActionId={busyActionId}
          onApprove={handleApprove}
          onDeny={handleDeny}
          onApply={handleApply}
          emptyMessage="No pending actions — the promotion loop is up to date."
        />
      ) : tab === "history" ? (
        <ActionList actions={history} readOnly emptyMessage="No historical actions yet." />
      ) : (
        <DashboardView dashboard={dashboard} />
      )}
      {ConfirmDialog}
    </div>
  );
}

function SummaryCard({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Inbox }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
          <p className="text-2xl font-bold text-[var(--text-primary)] mt-1">{value}</p>
        </div>
        <Icon className="h-5 w-5 text-[var(--text-muted)]" />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Inbox;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
        active
          ? "border-[var(--accent)] text-[var(--text-primary)]"
          : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      )}
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}

function ActionList({
  actions,
  busyActionId,
  onApprove,
  onDeny,
  onApply,
  readOnly,
  emptyMessage,
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
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-primary)] p-12 text-center text-sm text-[var(--text-muted)]">
        {emptyMessage}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {actions.map((a) => (
        <div
          key={a.action_id}
          className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                  {a.hook}
                </span>
                <StatusBadge status={a.status} />
                <span className="text-xs text-[var(--text-muted)]">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </div>
              <p className="mt-2 text-xs font-mono text-[var(--text-muted)] break-all">
                {a.action_id}
              </p>
              {a.payload && Object.keys(a.payload).length > 0 && (
                <pre className="mt-2 p-2 rounded bg-[var(--bg-tertiary)] text-[11px] font-mono text-[var(--text-secondary)] overflow-x-auto">
                  {JSON.stringify(a.payload, null, 2)}
                </pre>
              )}
            </div>
            {!readOnly && onApprove && onDeny && (
              <div className="flex flex-col gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="default"
                  disabled={busyActionId === a.action_id}
                  onClick={() => onApprove(a.action_id)}
                >
                  <Check className="h-3 w-3 mr-1" /> Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyActionId === a.action_id}
                  onClick={() => onDeny(a.action_id)}
                >
                  <X className="h-3 w-3 mr-1" /> Deny
                </Button>
                {onApply && a.status === "approved" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyActionId === a.action_id}
                    onClick={() => onApply(a.action_id)}
                  >
                    <Play className="h-3 w-3 mr-1" /> Apply
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    pending: "bg-[var(--warning)]/20 text-[var(--warning)] border-[var(--warning)]/30",
    approved: "bg-[var(--terminal)]/20 text-[var(--terminal)] border-[var(--terminal)]/30",
    denied: "bg-[var(--error)]/20 text-[var(--error)] border-[var(--error)]/30",
    applied: "bg-[var(--accent)]/20 text-[var(--accent)] border-[var(--accent)]/30",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border",
        colorMap[status] ?? "bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border-subtle)]"
      )}
    >
      {status}
    </span>
  );
}

function DashboardView({ dashboard }: { dashboard: Dashboard | null }) {
  if (!dashboard) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-primary)] p-12 text-center text-sm text-[var(--text-muted)]">
        Dashboard data unavailable.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Actions by hook</h3>
        {Object.keys(dashboard.by_hook).length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No actions recorded yet.</p>
        ) : (
          <ul className="space-y-2">
            {Object.entries(dashboard.by_hook)
              .sort(([, a], [, b]) => b - a)
              .map(([hook, count]) => (
                <li key={hook} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-[var(--text-secondary)]">{hook}</span>
                  <span className="text-[var(--text-muted)]">{count}</span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}
