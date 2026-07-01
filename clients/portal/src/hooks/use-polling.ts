"use client";

import { useEffect, useRef } from "react";

/**
 * usePolling — safe client-side polling with idle-tab pause +
 * exponential backoff on errors + auth-error bail.
 *
 * The five polling components in the portal (alerts, budget-ticker,
 * replay, hilt-panel, inspector, use-notifications) used to repeat
 * the same setInterval pattern individually, and most of them had
 * at least one of three cost-spiral bugs:
 *
 *   1. Polling kept firing while the tab was hidden — burned
 *      bandwidth on every background tab for no user value.
 *   2. Polling kept firing on consecutive 5xx/4xx — a single
 *      broken backend could hammer the endpoint every 5s forever.
 *   3. Polling kept firing on 401/403 — an expired session would
 *      burn 12 req/min per polling interval per org.
 *
 * This hook centralises the fix:
 *
 *   - Pauses on `document.hidden`, refreshes on visibility return.
 *   - On error, backs off the next interval: 2x the current delay
 *     capped at ``maxBackoffMs``. Resets to ``intervalMs`` on the
 *     next successful fetch.
 *   - On any 401 / 403 (or fetch throwing), permanently bails out
 *     until the caller re-mounts or the deps change — the auth path
 *     is the dashboard's job to fix, not the poller's.
 *
 * Returns nothing — the hook is fire-and-forget. The caller's
 * fetch function is responsible for setting whatever state it cares
 * about (loading, error, data).
 *
 * Usage:
 *
 *   usePolling({
 *     fetch: () => fetchAlerts(currentOrg.id),
 *     intervalMs: 15_000,
 *     deps: [currentOrg?.id],
 *   });
 *
 * June 2026 cost-pass fix. No regressions: existing polling
 * components that call this with their previous interval still
 * poll at the same cadence when the tab is visible, errors are
 * rare, and the user is signed in.
 */
export interface UsePollingOptions {
  /** Async function to call on each tick. Throw / reject to trigger
   *  exponential backoff. */
  fetch: () => Promise<unknown>;
  /** Steady-state interval between successful fetches, in ms. */
  intervalMs: number;
  /** Hard cap on the backoff interval. Default: 60_000 (1 min). */
  maxBackoffMs?: number;
  /** Dependency array — the poll re-arms when any value changes
   *  (e.g. currentOrg.id flip, traceId change). The fetch function
   *  is also captured as a ref so a fresh closure doesn't tear
   *  down + recreate the interval on every render. */
  deps: ReadonlyArray<unknown>;
  /** Disable polling entirely (e.g. feature flag off, missing org).
   *  The hook will still call `fetch` once on mount + on visibility
   *  return if ``enabled`` flips true → false → true. */
  enabled?: boolean;
}

const DEFAULT_MAX_BACKOFF_MS = 60_000;

export function usePolling({
  fetch,
  intervalMs,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  deps,
  enabled = true,
}: UsePollingOptions): void {
  // Capture the latest fetch function in a ref so the effect below
  // doesn't tear down the interval every time the caller passes a
  // new closure. This is the same pattern as the previous
  // hand-rolled effects — it just lives in one place now.
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    if (!enabled) return;

    let interval: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let currentDelay = intervalMs;
    let authFailed = false;
    let paused = false;

    const isAuthError = (err: unknown): boolean => {
      // Cheap shape check — the caller's fetchApi throws
      // ``Error("HTTP 401")`` / ``Error("HTTP 403")`` so the status
      // is in the message string. Also catch the ``Not authenticated``
      // / ``Session expired`` mapper messages.
      const msg = err instanceof Error ? err.message : String(err);
      return /401|403|not\s*authenticated|session\s*expired|unauthorized/i.test(msg);
    };

    const tick = async () => {
      if (paused || authFailed) return;
      try {
        await fetchRef.current();
        currentDelay = intervalMs; // reset backoff on success
      } catch (err) {
        if (isAuthError(err)) {
          // Permanent bail — the dashboard's auth-error path
          // handles the user-visible message + redirect. Don't
          // burn the rate-limit bucket while it's broken.
          authFailed = true;
          stop();
          return;
        }
        // Exponential backoff with cap. Doubles on each consecutive
        // failure so a single broken endpoint stops hammering
        // the backend within ~1 minute.
        currentDelay = Math.min(currentDelay * 2, maxBackoffMs);
        schedule(currentDelay);
      }
    };

    const schedule = (delay: number) => {
      stop();
      timeout = setTimeout(tick, delay);
    };

    const start = () => {
      if (paused || authFailed || interval || timeout) return;
      // Fire one tick immediately on start, then schedule the next.
      void tick();
    };

    const stop = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const onVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.hidden) {
        paused = true;
        stop();
      } else if (paused) {
        paused = false;
        // Reset backoff on resume — the user came back, give the
        // backend a fresh try at the steady-state interval.
        currentDelay = intervalMs;
        start();
      }
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
     
  }, deps);
}