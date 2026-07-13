"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";

/**
 * Global TanStack Query provider.
 *
 * Defaults are tuned for an interactive dashboard:
 *   - staleTime 60s: most pages don't need to re-fetch on every
 *     focus event; this matches the 60s polling cadence of
 *     the NotificationsProvider.
 *   - gcTime 5min: keep unused cache around long enough to cover
 *     a quick back-and-forth between two pages.
 *   - retry: skips ``ApiError`` 4xx responses other than 429 —
 *     those are permanent-until-fixed (400/401/403/404/422…) and
 *     retrying just delays the error from reaching the page. 429
 *     and 5xx get up to 2 retries with exponential backoff.
 *     ``fetchApi`` (``src/lib/api.ts``) already owns transport-level
 *     retries for 429 (Retry-After) and 5xx (backoff) *inside a
 *     single query execution* — this is a second, coarser safety
 *     net at the React Query layer for whatever slips through, not
 *     a duplicate of the same retry loop.
 *   - refetchOnWindowFocus false: we already poll via SWR-style
 *     providers; focus re-fetches are noise.
 *
 * Components opt in via ``useApiQuery`` / ``useOrgQuery`` (the thin
 * wrappers in ``src/hooks/use-api-query.ts``).
 */
function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError) {
    const isPermanentClientError = error.status >= 400 && error.status < 500 && error.status !== 429;
    if (isPermanentClientError) return false;
  }
  return failureCount < 2;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            retry: shouldRetry,
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
