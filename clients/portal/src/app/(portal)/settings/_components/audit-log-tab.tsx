"use client";

import { useState, useEffect } from "react";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { AuditEvent } from "@/lib/types";
import { Loader2, Filter, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

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
  "invitation.declined": "Invitation declined",
};

export function AuditLogTab({ org }: { org: any }) {
  const { hasPermission } = usePermissions();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<{
    action?: string;
    user_id?: string;
    from?: string;
    to?: string;
  }>({});
  const [showFilters, setShowFilters] = useState(false);

  const loadEvents = async (append = false) => {
    if (!org) return;
    setLoading(true);
    try {
      const data = await api.getAuditLog(org.id, {
        ...filter,
        limit: 50,
        offset: append ? events.length : 0,
      });
      if (append) {
        setEvents((prev) => [...prev, ...data.entries]);
      } else {
        setEvents(data.entries);
      }
      setTotal(data.total);
    } catch (e) {
      console.error("Failed to load audit log", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEvents();
  }, [org?.id, filter]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const formatAction = (action: string) => {
    return ACTION_LABELS[action] || action;
  };

  if (!org) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        Select an organization to view audit log
      </div>
    );
  }

  if (!hasPermission("audit:view")) {
    return (
      <div className="text-center py-12 text-[var(--text-secondary)]">
        You do not have permission to view audit logs
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="p-4 bg-[var(--bg-primary)] rounded-xl border border-[var(--border)]">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-[var(--text-muted)]" />
            <span className="text-sm font-medium">Audit Log</span>
            <span className="text-xs text-[var(--text-muted)]">({total} events)</span>
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              "px-3 py-1.5 text-sm border border-[var(--border)] rounded-lg flex items-center gap-1.5",
              showFilters && "bg-[var(--accent-faint)] border-[var(--accent)]"
            )}
          >
            <Filter className="w-4 h-4" />
            Filters
          </button>
        </div>

        {showFilters && (
          <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-[var(--border)]">
            <div>
              <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                Action Type
              </label>
              <select
                value={filter.action || ""}
                onChange={(e) => setFilter({ ...filter, action: e.target.value || undefined })}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm"
              >
                <option value="">All actions</option>
                {Object.entries(ACTION_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                From Date
              </label>
              <input
                type="date"
                value={filter.from || ""}
                onChange={(e) => setFilter({ ...filter, from: e.target.value || undefined })}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                To Date
              </label>
              <input
                type="date"
                value={filter.to || ""}
                onChange={(e) => setFilter({ ...filter, to: e.target.value || undefined })}
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] text-sm"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={() => setFilter({})}
                className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Clear filters
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Events List */}
      {loading && events.length === 0 ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-12 text-[var(--text-secondary)]">
          <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No audit events found</p>
          <p className="text-sm">Events will appear here as actions are taken</p>
        </div>
      ) : (
        <div className="bg-[var(--bg-primary)] rounded-xl border border-[var(--border)] overflow-hidden">
          <table className="w-full">
            <thead className="bg-[var(--bg-muted)]">
              <tr>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">When</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Actor</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Action</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Target</th>
                <th className="text-left px-4 py-3 text-sm font-medium text-[var(--text-secondary)]">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className="border-t border-[var(--border)]">
                  <td className="px-4 py-3 text-sm text-[var(--text-muted)]">
                    {formatDate(event.created_at)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <div className="font-medium">{event.user_name || "Unknown"}</div>
                    <div className="text-xs text-[var(--text-muted)]">{event.user_id?.slice(0, 8)}...</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      "px-2 py-1 rounded-md text-xs font-medium",
                      event.action.startsWith("member.")
                        ? "bg-[var(--accent-faint)] text-[var(--accent)]"
                        : event.action.startsWith("org.")
                        ? "bg-[var(--error-dim)] text-[var(--error)]"
                        : event.action.startsWith("reference.")
                        ? "bg-[var(--terminal-faint)] text-[var(--terminal)]"
                        : event.action.startsWith("settings.")
                        ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                        : "bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                    )}>
                      {formatAction(event.action)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {event.target_type && event.target_id ? (
                      <span className="text-[var(--text-muted)]">
                        {event.target_type}: {event.target_id.slice(0, 8)}...
                      </span>
                    ) : (
                      <span className="text-[var(--text-muted)]">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-muted)]">
                    {Object.keys(event.metadata || {}).length > 0 ? (
                      <code className="text-xs bg-[var(--bg-muted)] px-1.5 py-0.5 rounded">
                        {(() => {
                          const metaStr = JSON.stringify(event.metadata);
                          return metaStr.length > 50 ? metaStr.slice(0, 50) + "..." : metaStr;
                        })()}
                      </code>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {events.length < total && (
            <div className="p-4 border-t border-[var(--border)] text-center">
              <button
                onClick={() => loadEvents(true)}
                disabled={loading}
                className="px-4 py-2 text-sm text-[var(--accent)] hover:underline disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center gap-2 justify-center">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </span>
                ) : (
                  `Load more (${total - events.length} remaining)`
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}