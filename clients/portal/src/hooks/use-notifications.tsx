"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { api, ApiError } from "@/lib/api";
import { usePolling } from "@/hooks/use-polling";

export interface Notification {
  id: string;
  user_id: string;
  org_id: string | null;
  type: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

interface NotificationsContextType {
  notifications: Notification[];
  unreadCount: number;
  error: string | null;
  refresh: () => Promise<void>;
  markAsRead: (notificationId: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  deleteNotification: (notificationId: string) => Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextType | null>(null);

const POLL_INTERVAL_ACTIVE_MS = 30_000;
const POLL_INTERVAL_IDLE_MS = 300_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The shared ``usePolling`` hook owns the interval, visibility-pause,
  // exponential backoff on errors, and auth-error bail. June 2026
  // cost-pass — was previously a hand-rolled useEffect that lacked
  // the backoff + auth-bail safety nets.
  const refresh = useCallback(async () => {
    try {
      const data = await api.listNotifications({ limit: 20 });
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = e instanceof ApiError ? e.status : undefined;
      // 404 = endpoint not deployed yet (pre-launch). 5xx during the
      // post-signup auto-provision race is transient — swallow and
      // let the next poll succeed once /auth/me has created the row.
      // Match on status OR message: toUserFacingError strips "500" /
      // "unexpected error" from the message in production.
      const isTransient =
        (typeof status === "number" && status >= 500) ||
        status === 404 ||
        /404|not\s*found|5\d\d|unexpected\s*error|having\s*trouble\s*reaching/i.test(msg);
      if (isTransient) {
        setNotifications([]);
        setUnreadCount(0);
        setError(null);
        return;
      }
      // For other errors, log + clear state + re-throw so
      // ``usePolling`` can apply backoff / permanent auth-bail.
      console.error("Failed to load notifications:", e);
      setNotifications([]);
      setUnreadCount(0);
      setError("Failed to load notifications");
      throw e;
    }
  }, []);

  usePolling({
    fetch: refresh,
    intervalMs: unreadCount > 0 ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_IDLE_MS,
    deps: [unreadCount],
  });

  const markAsRead = useCallback(async (notificationId: string) => {
    // ponytail: optimistic update — flip is_read + decrement unread
    // immediately so the bell badge updates with zero perceived
    // latency. Roll back if the server rejects.
    setNotifications((prev) =>
      prev.map((n) =>
        n.id === notificationId ? { ...n, is_read: true } : n
      )
    );
    let wasUnread = false;
    setUnreadCount((prev) => {
      wasUnread = prev > 0;
      return Math.max(0, prev - 1);
    });
    try {
      await api.markNotificationRead(notificationId);
    } catch (e) {
      // Roll back on failure.
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notificationId ? { ...n, is_read: false } : n
        )
      );
      if (wasUnread) setUnreadCount((c) => c + 1);
      console.error("Failed to mark notification as read:", e);
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    const prevNotifications = notifications;
    const prevCount = unreadCount;
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, is_read: true }))
    );
    setUnreadCount(0);
    try {
      await api.markAllNotificationsRead();
    } catch (e) {
      setNotifications(prevNotifications);
      setUnreadCount(prevCount);
      console.error("Failed to mark all notifications as read:", e);
    }
  }, [notifications, unreadCount]);

  const deleteNotification = useCallback(async (notificationId: string) => {
    let snapshot: Notification[] = [];
    let wasUnread = false;
    setNotifications((prev) => {
      snapshot = prev;
      const deleted = prev.find((n) => n.id === notificationId);
      if (deleted && !deleted.is_read) wasUnread = true;
      return prev.filter((n) => n.id !== notificationId);
    });
    if (wasUnread) setUnreadCount((count) => Math.max(0, count - 1));
    try {
      await api.deleteNotification(notificationId);
    } catch (e) {
      setNotifications(snapshot);
      if (wasUnread) setUnreadCount((c) => c + 1);
      console.error("Failed to delete notification:", e);
    }
  }, []);

  return (
    <NotificationsContext.Provider
      value={{
        notifications,
        unreadCount,
        error,
        refresh,
        markAsRead,
        markAllAsRead,
        deleteNotification,
      }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationsContext);
  if (!context) {
    throw new Error("useNotifications must be used within NotificationsProvider");
  }
  return context;
}
