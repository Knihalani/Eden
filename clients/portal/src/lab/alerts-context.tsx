"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";

type AlertsContextValue = {
  open: boolean;
  openAlerts: () => void;
  closeAlerts: () => void;
  toggleAlerts: () => void;
  /** Unread notification count — drives the red badge (hidden at 0). */
  unreadCount: number;
  /** Firing alerts — preferred badge when > 0. */
  firingCount: number;
  isUnread: (id: string) => boolean;
  markRead: (id: string) => void;
  markAllRead: () => void;
};

const AlertsContext = createContext<AlertsContextValue | null>(null);

export function AlertsProvider({ children }: { children: ReactNode }) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const pathname = usePathname();
  const onHome = (pathname || "").split("?")[0] === "/home";

  // Match PortalCatalogSync: on Home, wait until agents settle so we
  // do not defeat the catalog deferral via a second enabled observer.
  const agentsWarm = useOrgQuery(
    queryKeys.portal.agents(orgId),
    orgId,
    () => portalApi.agents(orgId!),
    {
      staleTime: 60_000,
      enabled: Boolean(orgId) && onHome,
    },
  );

  const alertEventsQuery = useOrgQuery(
    queryKeys.portal.alertEvents(orgId),
    orgId,
    () => portalApi.alertEvents(orgId!),
    {
      staleTime: 60_000,
      // Settle (success or error) — not only isSuccess — so a failed
      // agents GET does not strand the alerts bell forever.
      enabled: !onHome || !agentsWarm.isPending,
    },
  );
  const events = alertEventsQuery.data ?? [];

  const [open, setOpen] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());

  const openAlerts = useCallback(() => setOpen(true), []);
  const closeAlerts = useCallback(() => setOpen(false), []);
  const toggleAlerts = useCallback(() => setOpen((v) => !v), []);

  const markRead = useCallback((id: string) => {
    setReadIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    setReadIds(new Set(events.map((e) => e.id)));
  }, [events]);

  const isUnread = useCallback((id: string) => !readIds.has(id), [readIds]);

  const firingCount = useMemo(
    () => events.filter((e) => e.status === "firing").length,
    [events],
  );
  const unreadCount = useMemo(
    () =>
      events.filter((e) => e.status === "firing" && !readIds.has(e.id)).length,
    [events, readIds],
  );

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Close alerts when the product tour opens so Escape/z-order stay clear.
  useEffect(() => {
    const onTour = () => setOpen(false);
    window.addEventListener("eden:product-tour", onTour);
    return () => window.removeEventListener("eden:product-tour", onTour);
  }, []);

  const value = useMemo(
    () => ({
      open,
      openAlerts,
      closeAlerts,
      toggleAlerts,
      unreadCount,
      firingCount,
      isUnread,
      markRead,
      markAllRead,
    }),
    [
      open,
      openAlerts,
      closeAlerts,
      toggleAlerts,
      unreadCount,
      firingCount,
      isUnread,
      markRead,
      markAllRead,
    ],
  );

  return (
    <AlertsContext.Provider value={value}>{children}</AlertsContext.Provider>
  );
}

export function useAlerts() {
  const ctx = useContext(AlertsContext);
  if (!ctx) {
    throw new Error("useAlerts must be used within AlertsProvider");
  }
  return ctx;
}
