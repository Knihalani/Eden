"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { AuthProvider } from "@/hooks/use-auth";
import { OrgProvider } from "@/hooks/use-org";

/** Exported (not just module-private) so the F41-3 retry-layering fix
 *  — the global default must not duplicate fetchApi's own transport
 *  retry — is directly unit-testable without mounting the full
 *  Clerk/Org provider tree. */
export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Prefer cache hits across portal navigations; leaf pages can
        // override with a tighter staleTime when freshness matters.
        // Match ``SHELL_QUERY`` / ``OBSERVE_STALE`` (90s).
        staleTime: 90_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        // Refetch on mount only when data is stale (> staleTime). Soft
        // nav within the window stays cache-hit; tour steps stay smooth.
        refetchOnMount: true,
        // F41-3: this used to retry once more on top of ``fetchApi``'s
        // own internal 5xx/429 backoff (core.ts) — every single
        // ``useApiQuery``/``useOrgQuery`` call site (there are ~58)
        // paid for a duplicate transport-level retry it never asked
        // for. ``fetchApi`` now exclusively owns transport retry
        // (401 refresh-retry, 5xx/429 backoff); React Query's job is
        // UI-level orchestration (staleness, refetch-on-mount, etc.),
        // not re-retrying the same failure class. Individual hooks
        // (e.g. ``useMeQuery``) can still opt into their own
        // business-level retry (e.g. the "user not found" race) via
        // a per-query ``retry`` option, which overrides this default.
        retry: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

/** Invalidate portal keys when docs-fill (or another tab) mints a key. */
function KeysMintedListener() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("eden-portal");
    } catch {
      return;
    }
    bc.onmessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (data?.type !== "keys-minted") return;
      void queryClient.invalidateQueries({
        queryKey: ["portal", "keys"],
      });
    };
    return () => {
      bc?.close();
    };
  }, [queryClient]);
  return null;
}

/**
 * Portal data layer: QueryClient → Auth → Org.
 * Mounted once under ``(portal)/layout`` so marketing/auth trees skip it.
 */
export function PortalProviders({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <KeysMintedListener />
      <AuthProvider>
        <OrgProvider>{children}</OrgProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
