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
 * Retry predicate for ``useMeQuery`` — exported (rather than kept
 * inline) so the F41-3 retry-layering fix is directly unit-testable.
 *
 * Retry layering (F41-3): ``fetchApi`` already owns transport-level
 * 401 handling (one-shot Clerk-token-refresh-then-retry) and 5xx
 * backoff — this hook must NOT add another 401-retry layer on top of
 * that or a persistent 401 turns 1 physical request into up to 6
 * (2 fetchApi attempts × up to 3 RQ retries). The only retry kept
 * here is the auto-provision "user not found" race, which is a
 * distinct business-level condition fetchApi has no opinion on (it's
 * a 404, not an auth/transport failure), so it isn't a duplicate of
 * anything the transport layer already does.
 */
export function meQueryRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  // Key off status + raw detail — sanitized message is not "User not found".
  return isUserNotFoundRace(error);
}

/**
 * Canonical ``/auth/me`` query. Enable only when Clerk has a signed-in
 * user; React Query dedupes in-flight requests across Auth + Org.
 * See ``meQueryRetry`` for the retry-layering rationale.
 */
export function useMeQuery(enabled: boolean) {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    enabled,
    staleTime: 60_000,
    retry: meQueryRetry,
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
