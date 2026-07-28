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
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { portalApi } from "@/lib/api/portal";
import { patchPortalCatalog } from "@/lib/portal-catalog";
import { ALERT_EVENTS_STALE } from "@/lib/portal-query";

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

/** Defer bell fetch so above-fold agents/traces win the first paint. */
const ALERT_EVENTS_BOOT_DELAY_MS = 2_500;

export function AlertsProvider({ children }: { children: ReactNode }) {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id ?? null;
  const [bootReady, setBootReady] = useState(false);

  useEffect(() => {
    if (!orgId) {
      setBootReady(false);
      return;
    }
    setBootReady(false);
    const t = window.setTimeout(() => setBootReady(true), ALERT_EVENTS_BOOT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [orgId]);

  // Subscribe to in-flight agents fetches without issuing a second GET.
  const agentsFetching = useIsFetching({
    queryKey: orgId ? queryKeys.portal.agents(orgId) : ["portal", "agents", "__none__"],
  });

  const alertEventsQuery = useOrgQuery(
    queryKeys.portal.alertEvents(orgId),
    orgId,
    () => portalApi.alertEvents(orgId!),
    {
      staleTime: ALERT_EVENTS_STALE,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      // After boot delay; wait out any in-flight agents shard so we
      // don't compete with above-the-fold home/traces paint.
      enabled: Boolean(orgId) && bootReady && agentsFetching === 0,
    },
  );
  const events = alertEventsQuery.data ?? [];

  useEffect(() => {
    if (alertEventsQuery.data === undefined) return;
    patchPortalCatalog({ alertEvents: alertEventsQuery.data });
  }, [alertEventsQuery.data]);

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

export function useAlerts(): AlertsContextValue {
  const context = useContext(AlertsContext);
  if (!context) {
    throw new Error("useAlerts must be used within AlertsProvider");
  }
  return context;
}
