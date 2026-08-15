/**
 * Shared React Query options for portal read models.
 *
 * Soft-nav within ``staleTime`` must stay cache-hit (no refetch) so
 * bandwidth does not jump on every sidebar click. Pages that need
 * fresher data override ``staleTime`` / ``refetchOnMount`` locally.
 */

import type { QueryClient } from "@tanstack/react-query";

/** Observe / shell lists — prefer cache across soft navigations. */
export const OBSERVE_STALE = 90_000;
export const SETTINGS_STALE = 120_000;
export const ASSIST_STALE = 30_000;
/** Agents / Home fleet metrics — short TTL; status and spend move often. */
export const LIVE_STALE = 20_000;

/** Alert-bell events — long TTL; badge freshness is not critical-path. */
export const ALERT_EVENTS_STALE = 180_000;

export const SHELL_QUERY = {
  staleTime: OBSERVE_STALE,
  refetchOnWindowFocus: false as const,
  // Within staleTime, soft-nav must not re-hit the proxy.
  refetchOnMount: false as const,
};

/**
 * Fleet + connection state — short TTL, refetch when stale on remount.
 * Never use ``refetchOnMount: "always"`` here: that ignored ``staleTime``
 * and defeated SSR dehydrate + soft-nav cache on every observer mount.
 */
export const LIVE_QUERY = {
  staleTime: LIVE_STALE,
  refetchOnWindowFocus: false as const,
  refetchOnMount: true as const,
};

export const SETTINGS_QUERY = {
  staleTime: SETTINGS_STALE,
  refetchOnWindowFocus: false as const,
  refetchOnMount: false as const,
};

/**
 * Drop org-scoped RQ shards on workspace switch without nuking
 * ``["auth","me"]`` (layout SSR + BootGate rely on that warm entry).
 */
export function dropOrgScopedQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (q) => {
      const key = q.queryKey;
      return !(
        Array.isArray(key) &&
        key.length >= 2 &&
        key[0] === "auth" &&
        key[1] === "me"
      );
    },
  });
  // Module-global debugger handoff sessions are not RQ-backed.
  void import("@/lab/fixtures/debugger").then((m) => {
    m.clearClientDebuggerSessions();
  });
}
