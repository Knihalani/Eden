/**
 * P18 — seed React Query cache for dashboard home (me + traces + summary).
 * Client ``page.tsx`` stays ``"use client"``; this server layout wraps it
 * in ``HydrationBoundary`` when an org session is available.
 *
 * Uses Eden org UUID from ``/auth/me`` so query keys match client
 * ``currentOrg.id`` (not the Clerk ``org_…`` id from ``auth().orgId``).
 * The same ``/auth/me`` payload is dehydrated under ``ME_QUERY_KEY`` so
 * AuthProvider / OrgProvider skip an immediate client refetch.
 */

import type { ReactNode } from "react";
import { HydrationBoundary } from "@tanstack/react-query";
import {
  dehydrateDashboardHome,
  type MePrefetchPayload,
} from "@/lib/portal-dehydrate";
import { bearerHeader } from "@/lib/server/clerk-bearer";

const API_BASE = process.env.API_INTERNAL_URL || "http://localhost:8000";

async function fetchAuthMe(
  headers: Record<string, string>,
): Promise<MePrefetchPayload | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { ...headers, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as MePrefetchPayload;
  } catch {
    return null;
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const headers = await bearerHeader();
  if (!headers.Authorization) {
    return children;
  }
  const me = await fetchAuthMe(headers);
  const orgId = me?.current_org_id ?? null;
  if (!me || !orgId) {
    return children;
  }
  const state = await dehydrateDashboardHome({
    apiBase: API_BASE,
    headers,
    orgId,
    me,
  });
  return <HydrationBoundary state={state}>{children}</HydrationBoundary>;
}
