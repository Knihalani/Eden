"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/lib/api/resources";
import { ApiError } from "@/lib/api/core";
import { usePolling } from "@/hooks/use-polling";
import { useOrg } from "@/hooks/use-org";
import { useObservabilityStream } from "@/hooks/use-observability-stream";

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

interface NotificationsState {
  notifications: Notification[];
  unreadCount: number;
  error: string | null;
}

interface NotificationsActions {
  refresh: () => Promise<void>;
  markAsRead: (notificationId: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  deleteNotification: (notificationId: string) => Promise<void>;
}

type NotificationsContextType = NotificationsState & NotificationsActions;

const NotificationsStateContext = createContext<NotificationsState | null>(
  null,
);
const NotificationsActionsContext = createContext<NotificationsActions | null>(
  null,
);
/** Combined context for existing ``useNotifications()`` consumers. */
const NotificationsContext = createContext<NotificationsContextType | null>(
  null,
);

// Poll interval demoted to a 5-minute fallback now that the SSE stream
// delivers notification:new events in real time. The active/idle
// distinction is kept for when SSE is unavailable (Redis down, reconnect
// cap hit, etc.) so the UI doesn't go silent for more than 5 minutes.
const POLL_INTERVAL_ACTIVE_MS = 300_000; // 5-minute fallback
const POLL_INTERVAL_IDLE_MS = 300_000;

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { isSignedIn, isLoaded } = useUser();
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? "";
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listNotifications({ limit: 20 });
      setNotifications(data.notifications);
      setUnreadCount(data.unread_count);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = e instanceof ApiError ? e.status : undefined;
      const isAuthOrMissing =
        status === 401 ||
        status === 403 ||
        status === 404 ||
        /401|403|404|unauthorized|not\s*found|forbidden/i.test(msg);
      if (isAuthOrMissing) {
        setNotifications([]);
        setUnreadCount(0);
        setError(null);
        return;
      }
      const isServerError =
        (typeof status === "number" && status >= 500) ||
        /5\d\d|unexpected\s*error|having\s*trouble\s*reaching|Backend (unreachable|timed out)/i.test(
          msg,
        );
      console.error("Failed to load notifications:", e);
      setNotifications([]);
      setUnreadCount(0);
      if (isServerError) {
        setError(null);
        throw e;
      }
      setError("Failed to load notifications");
      throw e;
    }
  }, []);

  // SSE live push: when the backend publishes a ``notification:new``
  // event, refresh immediately instead of waiting for the 5-min poll.
  // Shares the org's observability stream connection (no extra socket).
  // onNotification is stable (callback ref inside the hook) so this
  // call-site reference to ``refresh`` doesn't invalidate the stream.
  useObservabilityStream({
    orgId,
    enabled: Boolean(isLoaded && isSignedIn && orgId),
    onNotification: () => { void refresh(); },
  });

  usePolling({
    fetch: refresh,
    intervalMs: POLL_INTERVAL_ACTIVE_MS,
    deps: [isSignedIn],
    enabled: Boolean(isLoaded && isSignedIn),
  });

  const markAsRead = useCallback(async (notificationId: string) => {
    setNotifications((prev) =>
      prev.map((n) =>
        n.id === notificationId ? { ...n, is_read: true } : n,
      ),
    );
    let wasUnread = false;
    setUnreadCount((prev) => {
      wasUnread = prev > 0;
      return Math.max(0, prev - 1);
    });
    try {
      await api.markNotificationRead(notificationId);
    } catch (e) {
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === notificationId ? { ...n, is_read: false } : n,
        ),
      );
      if (wasUnread) setUnreadCount((c) => c + 1);
      console.error("Failed to mark notification as read:", e);
    }
  }, []);

  const markAllAsRead = useCallback(async () => {
    const prevNotifications = notifications;
    const prevCount = unreadCount;
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
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

  const stateValue = useMemo<NotificationsState>(
    () => ({ notifications, unreadCount, error }),
    [notifications, unreadCount, error],
  );

  const actionsValue = useMemo<NotificationsActions>(
    () => ({
      refresh,
      markAsRead,
      markAllAsRead,
      deleteNotification,
    }),
    [refresh, markAsRead, markAllAsRead, deleteNotification],
  );

  const combinedValue = useMemo<NotificationsContextType>(
    () => ({ ...stateValue, ...actionsValue }),
    [stateValue, actionsValue],
  );

  return (
    <NotificationsActionsContext.Provider value={actionsValue}>
      <NotificationsStateContext.Provider value={stateValue}>
        <NotificationsContext.Provider value={combinedValue}>
          {children}
        </NotificationsContext.Provider>
      </NotificationsStateContext.Provider>
    </NotificationsActionsContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationsContext);
  if (!context) {
    throw new Error(
      "useNotifications must be used within NotificationsProvider",
    );
  }
  return context;
}
