"use client";

import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api/auth-client";
import { ApiError } from "@/lib/api/core";

/**
 * Shared React Query key for ``GET /auth/me``.
 * AuthProvider + OrgProvider must both use this key so a cold portal
 * session issues exactly one network call (K1).
 */
export const ME_QUERY_KEY = ["auth", "me"] as const;

export type MeResponse = Awaited<ReturnType<typeof api.getMe>>;

async function fetchMe(): Promise<MeResponse> {
  return api.getMe();
}

/** True when /auth/me 404s with the auto-provision race detail. */
export function isUserNotFoundRace(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 404) return false;
  return /user\s*not\s*found/i.test(error.detail);
}

/**
 * Canonical ``/auth/me`` query. Enable only when Clerk has a signed-in
 * user; React Query dedupes in-flight requests across Auth + Org.
 */
export function useMeQuery(enabled: boolean) {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    enabled,
    staleTime: 60_000,
    retry: (failureCount, error) => {
      if (failureCount >= 2) return false;
      // Key off status + raw detail — sanitized message is not "User not found".
      if (isUserNotFoundRace(error)) return true;
      if (error instanceof ApiError && error.status === 401) {
        return failureCount < 2;
      }
      return false;
    },
    retryDelay: (attempt) => (attempt === 0 ? 250 : 500),
  });
}

/** Force a network round-trip and return the fresh ``/auth/me`` payload. */
export async function fetchMeQuery(queryClient: QueryClient): Promise<MeResponse> {
  await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  return queryClient.fetchQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
  });
}

export function useInvalidateMe() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
}
