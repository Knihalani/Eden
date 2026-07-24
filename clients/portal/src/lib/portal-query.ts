/**
 * Shared React Query options for portal read models.
 * Keep in sync with ``PortalProviders`` defaults (45s stale).
 */

export const OBSERVE_STALE = 45_000;
export const SETTINGS_STALE = 60_000;
export const ASSIST_STALE = 10_000;

/** Observe / shell lists — prefer cache across soft navigations. */
export const SHELL_QUERY = {
  staleTime: OBSERVE_STALE,
  refetchOnWindowFocus: false as const,
};

/** Settings shards — longer TTL; mutations invalidate explicitly. */
export const SETTINGS_QUERY = {
  staleTime: SETTINGS_STALE,
  refetchOnWindowFocus: false as const,
};
