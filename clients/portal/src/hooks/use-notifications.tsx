"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
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
  markAsRead: (notificationId: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  deleteNotification: (notificationId: string) => Promise<void>;
}

const NotificationsContext = createContext<NotificationsContextType | null>(null);

const POLL_INTERVAL_MS = 30_000;

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
      // 404 = endpoint not deployed yet (pre-launch). Silently
      // swallow and keep polling at the steady-state interval so
      // the bell comes back automatically once the route ships.
      if (/404|not\s*found/i.test(msg)) {
        setNotifications([]);
        setUnreadCount(0);
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
    intervalMs: POLL_INTERVAL_MS,
    deps: [],
  });

  const markAsRead = useCallback(async (notificationId: string) => {
    try {
      await api.markNotificationRead(notificationId);
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notificationId ? { ...n, is_read: true } : n
        )
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch (e) {
      console.error("Failed to mark notification as read:", e);
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    try {
      await api.markAllNotificationsRead();
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, is_read: true }))
      );
      setUnreadCount(0);
    } catch (e) {
      console.error("Failed to mark all notifications as read:", e);
    }
  }, []);

  const deleteNotification = useCallback(async (notificationId: string) => {
    try {
      await api.deleteNotification(notificationId);
      setNotifications((prev) => {
        const deleted = prev.find((n) => n.id === notificationId);
        if (deleted && !deleted.is_read) {
          setUnreadCount((count) => Math.max(0, count - 1));
        }
        return prev.filter((n) => n.id !== notificationId);
      });
    } catch (e) {
      console.error("Failed to delete notification:", e);
    }
  }, []);

  return (
    <NotificationsContext.Provider
      value={{
        notifications,
        unreadCount,
        error,
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
