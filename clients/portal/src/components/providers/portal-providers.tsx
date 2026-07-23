"use client";

import { useState, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { AuthProvider } from "@/hooks/use-auth";
import { OrgProvider } from "@/hooks/use-org";
import { ApiError } from "@/lib/api/core";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Prefer cache hits across portal navigations; leaf pages can
        // override with a tighter staleTime when freshness matters.
        staleTime: 45_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 1;
        },
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

/**
 * Portal data layer: QueryClient → Auth → Org.
 * Mounted once under ``(portal)/layout`` so marketing/auth trees skip it.
 */
export function PortalProviders({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <OrgProvider>{children}</OrgProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
