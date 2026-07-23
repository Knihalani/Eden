"use client";

import { Bell } from "lucide-react";
import { useAlerts } from "@/lab/alerts-context";
import { cn } from "@/lib/utils";

/** Bell control for shell chrome — badge = unread / firing count (hidden at 0). */
export function AlertsBell({ collapsed = false }: { collapsed?: boolean }) {
  const { openAlerts, unreadCount, firingCount, open } = useAlerts();
  const label =
    unreadCount > 0
      ? `Open alerts, ${unreadCount} unread`
      : "Open alerts";
  const badgeCount = firingCount > 0 ? firingCount : unreadCount;
  const badgeBad = firingCount > 0;

  return (
    <button
      type="button"
      onClick={openAlerts}
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
      <Bell className="h-4 w-4" strokeWidth={1.7} aria-hidden />
      {badgeCount > 0 ? (
        <span
          className={cn(
            "absolute flex min-w-[1.25rem] items-center justify-center rounded-full px-1 font-semibold",
            badgeBad
              ? "bg-[var(--error)] text-[var(--text-inverse)]"
              : "bg-[var(--accent)] text-[var(--text-inverse)]",
            "type-value !text-[0.6875rem] leading-none",
            "-right-1 -top-1 h-[1.25rem]",
          )}
        >
          {badgeCount > 9 ? "9+" : badgeCount}
        </span>
      ) : null}
    </button>
  );
}
