"use client";

import { useNotifications } from "@/hooks/use-notifications";
import { useEffect, useRef, useState } from "react";
import { Bell, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export function NotificationsDropdown() {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const {
    notifications,
    unreadCount,
    error,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    refresh: refreshNotifications,
  } = useNotifications();

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  // Escape closes; returns focus to the bell so keyboard users land
  // somewhere predictable.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const formatRelativeTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case "job_completed":
        return <Check className="w-4 h-4 text-[var(--terminal)]" />;
      case "job_failed":
        return <X className="w-4 h-4 text-[var(--error)]" />;
      default:
        return <Bell className="w-4 h-4 text-[var(--text-muted)]" />;
    }
  };

  return (
    <div ref={dropdownRef} className="relative">
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        className={cn(
          "relative",
          open
            ? "bg-[var(--accent-light)] text-[var(--accent)]"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]",
        )}
        aria-label="Notifications"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center bg-[var(--error)] text-[var(--bg-primary)] text-2xs font-bold rounded-full px-1">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="absolute right-0 mt-2 w-80 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg shadow-lg z-50 overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
            <h3 className="font-semibold text-sm text-[var(--text-primary)]">Notifications</h3>
            {unreadCount > 0 && (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => markAllAsRead()}
                className="h-auto px-0 text-xs font-medium"
              >
                Mark all as read
              </Button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-[320px] overflow-y-auto">
            {error && notifications.length === 0 ? (
              <div className="text-center py-8 px-4 space-y-3">
                <p className="text-sm text-[var(--error)]">{error}</p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() => void refreshNotifications()}
                  className="h-auto px-0 text-xs font-medium"
                >
                  Retry
                </Button>
              </div>
            ) : notifications.length === 0 ? (
              <div className="text-center py-8">
                <Bell className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)] stroke-1 opacity-50" />
                <p className="text-sm text-[var(--text-muted)]">No notifications</p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--border-subtle)]">
                {notifications.map((notification) => (
                  <div
                    key={notification.id}
                    className={cn(
                      "px-4 py-3 hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer",
                      !notification.is_read && "bg-[var(--accent-light)]/30"
                    )}
                    onClick={() => {
                      if (!notification.is_read) {
                        markAsRead(notification.id);
                      }
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 p-1.5 rounded bg-[var(--bg-tertiary)] shrink-0">
                        {getNotificationIcon(notification.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className={cn(
                            "text-sm font-medium truncate",
                            notification.is_read ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]"
                          )}>
                            {notification.title}
                          </p>
                          {notification.is_read && (
                            <Check className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                          )}
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2">
                          {notification.message}
                        </p>
                        <p className="text-xs text-[var(--text-muted)] mt-1">
                          {formatRelativeTime(notification.created_at)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteNotification(notification.id);
                        }}
                        className="h-7 w-7 shrink-0 text-[var(--text-muted)] hover:text-[var(--error)]"
                        aria-label="Delete notification"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
