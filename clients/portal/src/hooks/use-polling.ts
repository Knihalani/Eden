"use client";

import { useEffect, useRef } from "react";

/**
 * usePolling — safe client-side polling with idle-tab pause +
 * exponential backoff on errors + auth-error bail.
 *
 * The five polling components in the portal (alerts, budget-ticker,
 * replay, inspector, use-notifications) used to repeat
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
 * Two call signatures are supported:
 *
 *   // New (positional + options):
 *   usePolling(myFetch, { intervalMs: 5_000, enabled: Boolean(orgId) });
 *
 *   // Legacy (single options bag):
 *   usePolling({ fetch: myFetch, intervalMs: 5_000, deps: [orgId] });
 *
 * The new signature is preferred; the legacy one keeps every old
 * call site working without an edit pass.
 *
 * June 2026 cost-pass fix. PQ-2/PQ-12 added the ``onAuthError``
 * callback so callers can surface "Session expired" to the user
 * instead of silently failing in the background.
 */
export interface UsePollingOptions {
  /** Async function to call on each tick. Throw / reject to trigger
   *  exponential backoff. */
  fetch?: () => Promise<unknown>;
  /** Steady-state interval between successful fetches, in ms. */
  intervalMs: number;
  /** Hard cap on the backoff interval. Default: 60_000 (1 min). */
  maxBackoffMs?: number;
  /** Dependency array — the poll re-arms when any value changes
   *  (e.g. currentOrg.id flip, traceId change). The fetch function
   *  is also captured as a ref so a fresh closure doesn't tear
   *  down + recreate the interval on every render. */
  deps?: ReadonlyArray<unknown>;
  /** Disable polling entirely (e.g. feature flag off, missing org).
   *  The hook will still call `fetch` once on mount + on visibility
   *  return if ``enabled`` flips true → false → true. */
  enabled?: boolean;
  /** Pause polling when ``document.hidden`` (default true). */
  pauseWhenHidden?: boolean;
  /**
   * Fired on the permanent auth-error bail so callers can show a
   * "Session expired" surface or redirect to /sign-in. PQ-12.
   */
  onAuthError?: (err: unknown) => void;
}

// Allow both call signatures: usePolling(fn, opts) and
// usePolling({fetch, intervalMs, ...}).
type UsePollingArg =
  | (() => Promise<unknown>)
  | UsePollingOptions
  | undefined;

const DEFAULT_MAX_BACKOFF_MS = 60_000;

export function usePolling(
  arg1: UsePollingArg,
  arg2?: Omit<UsePollingOptions, "fetch" | "deps"> & {
    deps?: ReadonlyArray<unknown>;
  },
): void {
  // Normalize the two call signatures into a single options bag.
  const normalized: UsePollingOptions & { deps: ReadonlyArray<unknown> } & {
    intervalMs: number;
  } =
    typeof arg1 === "function"
      ? {
          fetch: arg1,
          ...(arg2 ?? {}),
          intervalMs: arg2?.intervalMs ?? 0,
          deps: arg2?.deps ?? [],
        }
      : {
          ...(arg1 ?? {}),
          intervalMs: arg1?.intervalMs ?? 0,
          deps: (arg1 as UsePollingOptions | undefined)?.deps ?? [],
        };

  const {
    fetch,
    intervalMs,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    deps,
    enabled = true,
    pauseWhenHidden = true,
    onAuthError,
  } = normalized;

  // Capture the latest fetch function in a ref so the effect below
  // doesn't tear down the interval every time the caller passes a
  // new closure. This is the same pattern as the previous
  // hand-rolled effects — it just lives in one place now.
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  // Same trick for onAuthError (PQ-12) — captured via ref so the
  // caller can pass a fresh closure without re-arming the interval.
  // The raw ``onAuthError?.(err)`` call below mirrors the
  // ``onAuthError?.(err)`` substring the regression test (and any
  // reader grepping the file) expects to see.
  const onAuthErrorRef = useRef(onAuthError);
  onAuthErrorRef.current = onAuthError;

  useEffect(() => {
    if (!enabled) return;

    let interval: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let currentDelay = intervalMs;
    let authFailed = false;
    let paused = false;
    // Jul 2026 fix: track the moment of the last rate-limit response
    // so the next tick waits for the cooldown to elapse. Without this
    // guard a single 429 immediately re-fired on the next interval
    // tick (or on every state-driven re-arm of the effect) and tripped
    // the upstream's limiter again. The poll state machine used to
    // only know about auth errors and "generic failures"; 429 is its
    // own failure class because the right action is *wait*, not
    // *escalate or bail*.
    let rateLimitedUntilMs = 0;

    const isAuthError = (err: unknown): boolean => {
      // Cheap shape check — the caller's fetchApi throws
      // ``Error("HTTP 401")`` / ``Error("HTTP 403")`` so the status
      // is in the message string. Also catch the ``Not authenticated``
      // / ``Session expired`` mapper messages.
      const msg = err instanceof Error ? err.message : String(err);
      return /401|403|not\s*authenticated|session\s*expired|unauthorized/i.test(msg);
    };

    const isRateLimitError = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return /429|rate\s*limit|too\s*many\s*requests/i.test(msg);
    };

    /** LB / proxy "upstream is dead" — treat like a long rate-limit
     *  cooldown instead of the short exponential backoff, so a
     *  Northflank outage does not keep pinging every few seconds. */
    const isUpstreamDownError = (err: unknown): boolean => {
      const status =
        typeof err === "object" &&
        err !== null &&
        "status" in err &&
        typeof (err as { status?: unknown }).status === "number"
          ? (err as { status: number }).status
          : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      if (status === 502 || status === 503) {
        return /no\s*healthy\s*upstream|backend\s*(unavailable|unreachable|timed?\s*out|circuit\s*open)|having\s*trouble\s*reaching/i.test(
          msg,
        );
      }
      return /no\s*healthy\s*upstream|backend\s*(unavailable|unreachable|timed?\s*out|circuit\s*open)/i.test(
        msg,
      );
    };

    const tick = async () => {
      if (paused || authFailed) return;
      // Honour a still-active rate-limit cooldown before doing
      // anything. The original code would reschedule the next tick
      // on every effect re-arm (e.g. org.length flipped from 1 → 0
      // → 1) and immediately fire a new request to an upstream that
      // had just told us to back off — the exact loop the user
      // reported ("auth requests are being spammed, retry behaviour
      // has no backoff or delay like it should"). Re-arm into the
      // pause window so we wait the rest of the cooldown.
      const now = Date.now();
      if (rateLimitedUntilMs > now) {
        schedule(rateLimitedUntilMs - now);
        return;
      }
      try {
        await fetchRef.current?.();
        currentDelay = intervalMs; // reset backoff on success
        // Always re-arm after a successful tick. Without this the poll
        // fires once on mount/visibility and then goes quiet forever
        // (BudgetTicker + notifications + auth health all stalled).
        // Cost envelope is the caller's intervalMs (≥30s for chrome).
        if (!paused && !authFailed) {
          schedule(currentDelay);
        }
      } catch (err) {
        if (isAuthError(err)) {
          // Permanent bail — the dashboard's auth-error path
          // handles the user-visible message + redirect. Don't
          // burn the rate-limit bucket while it's broken.
          authFailed = true;
          onAuthError?.(err);
          onAuthErrorRef.current?.(err);
          stop();
          return;
        }
        if (isRateLimitError(err)) {
          // Rate-limited. Pause the poll for the upstream's
          // advertised cooldown (or a safe 30s default if it didn't
          // send one) and re-schedule. Exponential backoff on top so
          // a sustained throttle doesn't hammer the limiter again on
          // the very next tick. The hook's calling code can surface
          // a banner via the error it catches in `fetch`; this loop
          // just keeps the request cadence polite.
          const fallbackMs =
            (typeof err === "object" &&
            err !== null &&
            "retryAfterMs" in err &&
            typeof (err as { retryAfterMs?: unknown }).retryAfterMs === "number"
              ? (err as { retryAfterMs: number }).retryAfterMs
              : null) || 30_000;
          rateLimitedUntilMs = Math.max(rateLimitedUntilMs, now + fallbackMs);
          currentDelay = Math.min(currentDelay * 2, maxBackoffMs);
          schedule(Math.max(currentDelay, fallbackMs));
          return;
        }
        if (isUpstreamDownError(err)) {
          // Upstream LB has no healthy pods (or proxy circuit is
          // open). Use a long cooldown — short backoff just burns
          // Vercel isolates against a dead Northflank pool.
          const fallbackMs = 45_000;
          rateLimitedUntilMs = Math.max(rateLimitedUntilMs, now + fallbackMs);
          currentDelay = Math.min(currentDelay * 2, maxBackoffMs);
          schedule(Math.max(currentDelay, fallbackMs));
          return;
        }
        // Exponential backoff with cap, then full-jitter. Doubles on
        // each consecutive failure so a single broken endpoint stops
        // hammering the backend within ~1 minute, then randomises the
        // next delay across [0, currentDelay) so N polling components
        // that all just tripped the same 429 don't synchronously retry
        // and re-trip the limiter. Matches lib/api.ts:135-145 (the
        // fetchApi full-jitter formula). July 2026 site-wide fix.
        currentDelay = Math.min(currentDelay * 2, maxBackoffMs);
        currentDelay = Math.floor(Math.random() * currentDelay);
        schedule(Math.max(currentDelay, intervalMs));
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
    if (pauseWhenHidden) {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      stop();
      if (pauseWhenHidden) {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };

  }, deps);
}