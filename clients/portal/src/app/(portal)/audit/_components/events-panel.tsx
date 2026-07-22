"use client";

import { useEffect, useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import type { AuditEvent } from "@/lib/types";
import { FileText, Filter } from "lucide-react";
import { cn } from "@/lib/utils";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PermissionGate } from "@/components/settings/permission-gate";
import { QueryState } from "@/components/ui/query-state";
import { Skeleton } from "@/components/ui/skeleton";
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
  "org.archived": "Workspace archived",
  "org.deleted": "Workspace deleted",
  "billing.subscription_changed": "Subscription changed",
  "invitation.declined": "Invitation declined",
};

const EVENTS_PAGE = 50;

export type EventsFilter = {
  action?: string;
  from?: string;
  to?: string;
};

export function EventsPanel({ orgId }: { orgId: string }) {
  const { hasPermission } = usePermissions();
  const [filter, setFilter] = useState<EventsFilter>({});
  const [showFilters, setShowFilters] = useState(false);
  const [extraEvents, setExtraEvents] = useState<AuditEvent[]>([]);
  const [appendError, setAppendError] = useState<string | null>(null);

  const logQuery = useOrgQuery(
    queryKeys.auditLog.list(orgId, filter),
    orgId,
    () => api.getAuditLog(orgId, { ...filter, limit: EVENTS_PAGE, offset: 0 }),
  );

  const baseEvents = (logQuery.data?.entries ?? []) as AuditEvent[];
  const events = extraEvents.length
    ? [...baseEvents, ...extraEvents]
    : baseEvents;
  const total = logQuery.data?.total ?? 0;

  useEffect(() => {
    setExtraEvents([]);
    setAppendError(null);
  }, [orgId, filter]);

  const loadMore = async () => {
    setAppendError(null);
    try {
      const data = await api.getAuditLog(orgId, {
        ...filter,
        limit: EVENTS_PAGE,
        offset: baseEvents.length + extraEvents.length,
      });
      setExtraEvents((prev) => [
        ...prev,
        ...(data.entries as AuditEvent[]),
      ]);
    } catch (e) {
      setAppendError(errorFromCaught(e, "Failed to load audit log"));
    }
  };

  if (!hasPermission("audit:view")) {
    return <PermissionGate permission="audit:view" />;
  }

  const columns: DataTableColumn<AuditEvent>[] = [
    {
      key: "created_at",
      header: "When",
      sortable: true,
      cell: (e) => (
        <span className="text-sm text-[var(--text-muted)] tabular-nums">
          {new Date(e.created_at).toLocaleString()}
        </span>
      ),
    },
    {
      key: "user_name",
      header: "Actor",
      sortable: true,
      cell: (e) => (
        <span className="font-medium text-[var(--text-primary)]">
          {e.user_name || "Unknown"}
        </span>
      ),
    },
    {
      key: "action",
      header: "Action",
      sortable: true,
      cell: (e) => (
        <span className="text-sm text-[var(--text-primary)]">
          {ACTION_LABELS[e.action] || e.action}
        </span>
      ),
    },
    {
      key: "target_id",
      header: "Target",
      cell: (e) =>
        e.target_type && e.target_id ? (
          <span className="text-sm text-[var(--text-muted)] font-mono">
            {e.target_type}:{e.target_id.slice(0, 8)}…
          </span>
        ) : (
          <span className="text-sm text-[var(--text-muted)]">—</span>
        ),
    },
  ];

  const openControlCount = showFilters ? 5 : 1;

  return (
    <div className="space-y-space-4">
      <div
        data-testid="audit-trail-events-toolbar"
        data-ws6-toolbar-controls={String(openControlCount)}
        className="flex flex-wrap items-center gap-space-2"
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("min-h-11", showFilters && "text-[var(--accent)]")}
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
        >
          <Filter className="h-4 w-4" aria-hidden />
          Filters
        </Button>
        {showFilters ? (
          <>
            <select
              value={filter.action || ""}
              onChange={(e) =>
                setFilter({
                  ...filter,
                  action: e.target.value || undefined,
                })
              }
              aria-label="Action type"
              className="min-h-11 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-2 py-space-1.5 text-xs"
            >
              <option value="">All actions</option>
              {Object.entries(ACTION_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={filter.from || ""}
              onChange={(e) =>
                setFilter({
                  ...filter,
                  from: e.target.value || undefined,
                })
              }
              aria-label="From date"
              className="min-h-11 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-2 py-space-1.5 text-xs"
            />
            <input
              type="date"
              value={filter.to || ""}
              onChange={(e) =>
                setFilter({
                  ...filter,
                  to: e.target.value || undefined,
                })
              }
              aria-label="To date"
              className="min-h-11 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-2 py-space-1.5 text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11"
              onClick={() => setFilter({})}
            >
              Clear
            </Button>
          </>
        ) : null}
      </div>

      <QueryState
        loading={logQuery.isLoading}
        error={logQuery.error}
        data={logQuery.data}
        onRetry={() => void logQuery.refetch()}
        errorTitle="Could not load audit log"
        isEmpty={(d) => (d?.entries.length ?? 0) === 0}
        loadingSlot={
          <div className="space-y-2 py-4" aria-busy="true">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        }
        emptySlot={
          <EmptyState
            variant="plain"
            icon={FileText}
            title="No privileged events yet"
            description="Member invites, role changes, billing updates, and other workspace admin actions appear here. Switch to Chain packs for agent ledger hashes and compliance exports."
          />
        }
      >
        {() => (
          <div className="space-y-space-3">
            <p className="text-sm text-[var(--text-secondary)]">
              {total} privileged events
            </p>
            <div className="rounded-lg border border-[var(--border-default)] overflow-hidden">
              <DataTable
                columns={columns}
                rows={events}
                rowKey={(e) => e.id}
                loading={logQuery.isLoading}
                defaultSort={{ key: "created_at", direction: "desc" }}
                emptyTitle="No privileged events yet"
                emptyDescription="Events appear as privileged workspace actions are taken"
                emptyIcon={FileText}
                pageSize={1000}
              />
              {appendError ? (
                <div className="p-4 border-t border-[var(--border)]">
                  <ErrorState
                    title="Could not load more events"
                    message={appendError}
                    size="sm"
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void loadMore()}
                      >
                        Try again
                      </Button>
                    }
                  />
                </div>
              ) : events.length < total ? (
                <div className="p-3 border-t border-[var(--border)] text-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-11"
                    onClick={() => void loadMore()}
                    disabled={logQuery.isFetching}
                  >
                    Load more ({total - events.length} remaining)
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </QueryState>
    </div>
  );
}
