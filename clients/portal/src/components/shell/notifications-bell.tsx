"use client";

/**
 * Bell control for the portal's in-app notification inbox
 * (``NotificationsProvider`` / ``use-notifications.tsx``).
 *
 * Distinct from ``AlertsBell`` (the Signals firing-alerts inbox) — this
 * surfaces the generic ``notifications`` table the backend writes to on
 * events like budget-threshold crossings (``budget_service``'s
 * ``evaluate_budget_alerts`` / ``_notify_budget_alert``), which today
 * have no visible home in the portal.
 */

import { useEffect, useId, useState } from "react";
import { Inbox, X } from "lucide-react";
import { useNotifications } from "@/hooks/use-notifications";
import { cn } from "@/lib/utils";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMin = Math.round((Date.now() - then) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

export function NotificationsBell({
  collapsed = false,
}: {
  collapsed?: boolean;
}) {
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    refresh,
  } = useNotifications();
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const label =
    unreadCount > 0
      ? `Open notifications, ${unreadCount} unread`
      : "Open notifications";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "relative flex items-center justify-center rounded-[var(--radius)] transition-colors",
          collapsed
            ? "h-8 w-8 hover:bg-[var(--bg-hover)]"
            : "ds-btn ds-btn-ghost ds-btn-icon",
          open && "bg-[var(--accent-muted)]",
        )}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Inbox className="h-4 w-4" strokeWidth={1.7} aria-hidden />
        {unreadCount > 0 ? (
          <span
            className={cn(
              "absolute flex min-w-[1.25rem] items-center justify-center rounded-full px-1 font-semibold",
              "bg-[var(--accent)] text-[var(--text-inverse)]",
              "type-value !text-[0.6875rem] leading-none",
              "-right-1 -top-1 h-[1.25rem]",
            )}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[70] flex items-stretch justify-center bg-[var(--scrim)] p-3 sm:items-start sm:justify-end sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-sm flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)] sm:max-h-[80vh]"
          >
            <header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
              <h2 id={titleId} className="type-ui text-[var(--text)]">
                Notifications
              </h2>
              <div className="flex items-center gap-1">
                {unreadCount > 0 ? (
                  <button
                    type="button"
                    className="ds-btn ds-btn-ghost ds-btn-sm"
                    onClick={() => void markAllAsRead()}
                  >
                    Mark all read
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ds-btn ds-btn-ghost ds-btn-icon"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {notifications.length === 0 ? (
                <p className="type-meta px-4 py-6 text-center">
                  No notifications yet.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--line)]">
                  {notifications.map((n) => (
                    <li
                      key={n.id}
                      className={cn(
                        "flex items-start gap-2 px-4 py-3",
                        !n.is_read && "bg-[var(--accent-muted)]",
                      )}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          if (!n.is_read) void markAsRead(n.id);
                        }}
                      >
                        <p className="type-ui text-[var(--text)]">{n.title}</p>
                        <p className="type-meta mt-0.5">{n.message}</p>
                        <p className="type-meta mt-1 text-[var(--text-faint)]">
                          {relativeTime(n.created_at)}
                        </p>
                      </button>
                      <button
                        type="button"
                        className="ds-btn ds-btn-ghost ds-btn-icon !h-7 !w-7 shrink-0"
                        onClick={() => void deleteNotification(n.id)}
                        aria-label="Delete notification"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
