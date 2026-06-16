"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/**
 * Global TanStack Query provider.
 *
 * Defaults are tuned for an interactive dashboard:
 *   - staleTime 60s: most pages don't need to re-fetch on every
 *     focus event; this matches the 60s polling cadence of
 *     the NotificationsProvider.
 *   - gcTime 5min: keep unused cache around long enough to cover
 *     a quick back-and-forth between two pages.
 *   - retry 2 with exponential backoff: tolerates transient 5xx
 *     without hammering the backend.
 *   - refetchOnWindowFocus false: we already poll via SWR-style
 *     providers; focus re-fetches are noise.
 *
 * Components opt in via ``useApiQuery`` (the thin wrapper in
 * ``src/hooks/use-api-query.ts``).
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            retry: 2,
            retryDelay: (i) => Math.min(1000 * 2 ** i, 10_000),
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
          },
          mutations: {
            retry: 0,
          },
        },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
