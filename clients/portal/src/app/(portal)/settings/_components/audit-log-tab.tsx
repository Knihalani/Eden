"use client";

import { useState, useEffect } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { AuditEvent, type Organization } from "@/lib/types";
import { Loader2, Filter, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { errorFromCaught } from "@/lib/safe-error-message";
const ACTION_LABELS: Record<string, string> = {
  "member.invited": "Member invited",
  "member.joined": "Member joined",
  "member.removed": "Member removed",
  "member.role_changed": "Role changed",
  "ownership.transferred": "Ownership transferred",
  "reference.uploaded": "Reference uploaded",
  "reference.deleted": "Reference deleted",
  "settings.updated": "Settings updated",
  "org.archived": "Organization archived",
  "org.deleted": "Organization deleted",
  "billing.subscription_changed": "Subscription changed",
  "invitation.declined": "Invitation declined"
};

export function AuditLogTab({
  org
}: {
  org: Organization | null | undefined;
}) {
  const {
    hasPermission
  } = usePermissions();
  const orgId = org?.id ?? null;
  const [extraEvents, setExtraEvents] = useState<AuditEvent[]>([]);
  const [appendError, setAppendError] = useState<string | null>(null);
  const [filter, setFilter] = useState<{
    action?: string;
    user_id?: string;
    from?: string;
    to?: string;
  }>({});
  const [showFilters, setShowFilters] = useState(false);
  const logQuery = useOrgQuery(
    queryKeys.auditLog.list(orgId, filter),
    orgId,
    () => api.getAuditLog(orgId!, { ...filter, limit: 50, offset: 0 }),
  );
  const baseEvents = logQuery.data?.entries ?? [];
  const events = extraEvents.length ? [...baseEvents, ...extraEvents] : baseEvents;
  const total = logQuery.data?.total ?? 0;
  const loading = logQuery.isLoading;
  const loadError = logQuery.error
    ? errorFromCaught(logQuery.error, "Failed to load audit log")
    : null;
  const loadEvents = async (append = false) => {
    if (!orgId) return;
    setAppendError(null);
    if (!append) {
      setExtraEvents([]);
      await logQuery.refetch();
      return;
    }
    try {
      const data = await api.getAuditLog(orgId, {
        ...filter,
        limit: 50,
        offset: baseEvents.length + extraEvents.length,
      });
      setExtraEvents((prev) => [...prev, ...data.entries]);
    } catch (e) {
      console.error("Failed to load audit log", e);
      setAppendError(errorFromCaught(e, "Failed to load audit log"));
    }
  };
  useEffect(() => {
    setExtraEvents([]);
    setAppendError(null);
  }, [orgId, filter]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };
  const formatAction = (action: string) => {
    return ACTION_LABELS[action] || action;
  };
  if (!org) {
    return <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to view audit log
      </div>;
  }
  if (!hasPermission("audit:view")) {
    return <div className="text-center py-12 text-[var(--text-secondary)]">
        You do not have permission to view audit logs
      </div>;
  }
  const actionPill = (action: string) => cn("px-2 py-1 rounded-md text-xs font-medium", action.startsWith("member.") ? "bg-[var(--accent-faint)] text-[var(--accent)]" : action.startsWith("org.") ? "bg-[var(--error-dim)] text-[var(--error)]" : action.startsWith("reference.") ? "bg-[var(--terminal-faint)] text-[var(--terminal)]" : action.startsWith("settings.") ? "bg-[var(--warning-bg)] text-[var(--warning)]" : "bg-[var(--bg-secondary)] text-[var(--text-secondary)]");
  const columns: DataTableColumn<AuditEvent>[] = [{
    key: "created_at",
    header: "When",
    sortable: true,
    cell: e => <span className="text-sm text-[var(--text-muted)]">{formatDate(e.created_at)}</span>
  }, {
    key: "user_name",
    header: "Actor",
    sortable: true,
    cell: e => <div>
          <div className="font-medium">{e.user_name || "Unknown"}</div>
          <div className="text-xs text-[var(--text-muted)]">{e.user_id?.slice(0, 8)}…</div>
        </div>
  }, {
    key: "action",
    header: "Action",
    sortable: true,
    cell: e => <span className={actionPill(e.action)}>{formatAction(e.action)}</span>
  }, {
    key: "target_id",
    header: "Target",
    cell: e => e.target_type && e.target_id ? <span className="text-sm text-[var(--text-muted)]">
            {e.target_type}: {e.target_id.slice(0, 8)}…
          </span> : <span className="text-sm text-[var(--text-muted)]">-</span>
  }, {
    key: "metadata",
    header: "Details",
    cell: e => {
      const meta = e.metadata || {};
      const keys = Object.keys(meta);
      if (keys.length === 0) return <span className="text-sm text-[var(--text-muted)]">-</span>;
      const metaStr = JSON.stringify(meta);
      return <code className="text-xs bg-[var(--bg-muted)] px-1.5 py-0.5 rounded">
            {metaStr.length > 50 ? metaStr.slice(0, 50) + "..." : metaStr}
          </code>;
    }
  }];
  return <div className="space-y-4">
      {/* Filters */}
      <Card padding="md">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-[var(--text-muted)]" />
            <span className="text-sm font-medium">Audit Log</span>
            <span className="text-xs text-[var(--text-muted)]">({total} events)</span>
          </div>
          <button onClick={() => setShowFilters(!showFilters)} className={cn("px-3 py-1.5 text-sm border border-[var(--border)] rounded-lg flex items-center gap-1.5", showFilters && "bg-[var(--accent-faint)] border-[var(--accent)]")}>
            <Filter className="w-4 h-4" />
            Filters
          </button>
        </div>

        {showFilters && <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-[var(--border)]">
            <div>
              <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                Action Type
              </label>
              <select value={filter.action || ""} onChange={e => setFilter({
            ...filter,
            action: e.target.value || undefined
          })} className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm">
                <option value="">All actions</option>
                {Object.entries(ACTION_LABELS).map(([key, label]) => <option key={key} value={key}>
                    {label}
                  </option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                From Date
              </label>
              <input type="date" value={filter.from || ""} onChange={e => setFilter({
            ...filter,
            from: e.target.value || undefined
          })} className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                To Date
              </label>
              <input type="date" value={filter.to || ""} onChange={e => setFilter({
            ...filter,
            to: e.target.value || undefined
          })} className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm" />
            </div>
            <div className="flex items-end">
              <button onClick={() => setFilter({})} className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                Clear filters
              </button>
            </div>
          </div>}
      </Card>

      {loadError ? (
        <ErrorState
          title="Could not load audit log"
          message={loadError}
          action={
            <Button variant="outline" size="sm" onClick={() => void loadEvents(false)}>
              Try again
            </Button>
          }
        />
      ) : loading && events.length === 0 ? <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div> : <Card padding="lg" className="overflow-hidden">
          <DataTable columns={columns} rows={events} rowKey={e => e.id} loading={loading} defaultSort={{
        key: "created_at",
        direction: "desc"
      }} emptyTitle="No audit events found" emptyDescription="Events will appear here as actions are taken" emptyIcon={FileText} pageSize={1000} />

          {appendError ? (
            <div className="p-4 border-t border-[var(--border)]">
              <ErrorState
                title="Could not load more events"
                message={appendError}
                size="sm"
                action={
                  <Button variant="outline" size="sm" onClick={() => void loadEvents(true)}>
                    Try again
                  </Button>
                }
              />
            </div>
          ) : events.length < total ? (
            <div className="p-4 border-t border-[var(--border)] text-center">
              <button onClick={() => loadEvents(true)} disabled={loading} className="px-4 py-2 text-sm text-[var(--accent)] hover:underline disabled:opacity-50">
                {loading ? <span className="flex items-center gap-2 justify-center">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </span> : `Load more (${total - events.length} remaining)`}
              </button>
            </div>
          ) : null}
        </Card>}
    </div>;
}
