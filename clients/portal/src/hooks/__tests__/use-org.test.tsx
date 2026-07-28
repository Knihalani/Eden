// @vitest-environment jsdom
/**
 * Regression tests for F41-3 (retry-layer de-duplication) AND its
 * follow-up fix (restoring a single bounded retry for the post-signup
 * JWT-propagation race), both in ``use-org.tsx``.
 *
 * History:
 *  - Pre-F41-3: ``refreshOrgs`` hand-rolled its own 3-attempt
 *    [0, 300, 800]ms retry loop around a 401, stacked on top of
 *    ``fetchApi``'s own one-shot Clerk-token-refresh-then-retry
 *    (core.ts) — each loop iteration could itself trigger a fresh
 *    refresh-retry, so a persistent 401 could burn up to 6 physical
 *    ``/auth/me`` requests instead of 2.
 *  - F41-3 removed that loop entirely. That fixed the stacking, but
 *    also silently removed the ONLY thing giving the real post-signup
 *    JWT-propagation race (ce7f7a9f) time to resolve — ``fetchApi``'s
 *    retry is essentially instant and doesn't reproduce that delay, so
 *    a 401 landing in that window would incorrectly paint "Session
 *    expired" right after signup.
 *  - This file's fix: ``recoverFromAuthPropagationRace`` in
 *    ``use-org.tsx`` is now the SINGLE place that waits (~1200ms) and
 *    retries once for a 401, shared (via a ref-based lock) by both
 *    ``refreshOrgs`` and the mount-time ``meQuery.error`` effect, so
 *    the wait can never happen twice concurrently for the same
 *    failure and no code path re-introduces a multi-attempt loop.
 *    The 1200ms figure matches the ORIGINAL loop's real worst-case
 *    coverage (cumulative 0+300+800ms ≈ 1100ms across its 3 attempts,
 *    not just the 800ms last-gap value) plus a small buffer — an
 *    earlier version of this fix used 600ms, which under-covered the
 *    race for delays in the ~600-1100ms range.
 *
 * The tests below cover both: (1) a persistent 401 still resolves to
 * the session banner, just after ONE bounded ~1200ms wait (not the old
 * 0ms-with-no-wait behavior, and not the older 3-attempt/up-to-1100ms
 * behavior either); (2) a 401 that succeeds once retried after a
 * delay close to the original loop's real worst case (the actual
 * race, not just an easy near-instant case) must NOT show the
 * session-expired banner, and must not cost more than the one
 * intended bounded retry.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/core";

const getMeMock = vi.fn();

vi.mock("@/lib/api/auth-client", () => ({
  api: { getMe: (...args: unknown[]) => getMeMock(...args) },
}));

vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({ organization: null, membership: null, isLoaded: true }),
  useUser: () => ({ user: { id: "user_1" }, isLoaded: true }),
}));

// Isolate the test from usePolling's own mount-time + interval fetch —
// we only want to measure calls triggered by our explicit
// `refreshOrgs()` invocation below.
vi.mock("@/hooks/use-polling", () => ({
  usePolling: () => {},
}));

import { OrgProvider, useOrg } from "../use-org";

type OrgContextType = ReturnType<typeof useOrg>;

function Consumer({ onReady }: { onReady: (ctx: OrgContextType) => void }) {
  const ctx = useOrg();
  onReady(ctx);
  return null;
}

beforeEach(() => {
  getMeMock.mockReset();
  // jsdom's window (and therefore sessionStorage) persists across
  // tests within this file — clear the flag so one test's outcome
  // can't leak into the next test's assertions.
  if (typeof window !== "undefined") {
    window.sessionStorage.clear();
  }
});

describe("refreshOrgs (F41-3 + post-signup JWT-propagation race fix)", () => {
  it("issues at most one bounded recovery retry per refreshOrgs() invocation on a persistent 401 — not the old 3-attempt loop, but not zero-delay either", async () => {
    getMeMock.mockRejectedValue(new ApiError(401, "Unauthorized", "Unauthorized"));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    let latestCtx: OrgContextType | undefined;
    render(
      <QueryClientProvider client={queryClient}>
        <OrgProvider>
          <Consumer onReady={(ctx) => { latestCtx = ctx; }} />
        </OrgProvider>
      </QueryClientProvider>,
    );

    // The mounted `useMeQuery` fires its own /auth/me call on mount,
    // which now also runs through the bounded-retry recovery path
    // before settling into the session banner — wait for that full
    // cycle so we have a clean baseline call count.
    await waitFor(() => expect(latestCtx?.authErrorKind).toBe("session"), {
      timeout: 4000,
    });
    await waitFor(() => expect(latestCtx?.loading).toBe(false));
    const baseline = getMeMock.mock.calls.length;

    getMeMock.mockClear();

    // The mount-time 401 already set authErrorKind to "session", and
    // refreshOrgs() intentionally no-ops while that's set ("Session
    // expiry blocks auto-refresh until the user retries" — see
    // use-org.tsx). Clear it first, exactly like a user hitting the
    // banner's "Retry" button would, so this call actually reaches
    // the retry code path under test.
    latestCtx?.clearAuthError();
    const startedAt = Date.now();
    await latestCtx?.refreshOrgs();
    const elapsedMs = Date.now() - startedAt;

    // fetchMeQuery() itself issues up to 2 physical calls per
    // invocation (an active-query refetch triggered by
    // invalidateQueries, then the explicit fetchQuery) — that's
    // pre-existing behavior unrelated to this fix. refreshOrgs now
    // makes at most TWO such fetchMeQuery invocations total: the
    // initial attempt, and (since the 401 persists) exactly one
    // bounded recovery retry via recoverFromAuthPropagationRace — so
    // up to 4 physical calls, never the old loop's additional
    // iterations (which could reach 6+).
    expect(getMeMock.mock.calls.length).toBeLessThanOrEqual(4);
    expect(getMeMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Bounded but NOT instant: the recovery retry deliberately waits
    // ~1200ms (see recoverFromAuthPropagationRace's doc comment) —
    // matching the old loop's real worst-case coverage (0+300+800ms
    // cumulative) plus a small buffer — before its one extra attempt,
    // while also no longer being the near-0ms "no delay at all"
    // behavior F41-3 left in place.
    expect(elapsedMs).toBeGreaterThanOrEqual(1150);
    expect(elapsedMs).toBeLessThan(2500);
    expect(baseline).toBeGreaterThanOrEqual(1);
  });

  it("recovers from a delayed-success 401 (the real post-signup JWT-propagation race) without ever surfacing the session-expired banner, using only the one intended bounded retry", async () => {
    const testStart = Date.now();
    // Simulates the real race: /auth/me 401s until the session JWT has
    // had time to propagate server-side, then succeeds — NOT an
    // instant retry succeeding (that path was already covered by
    // fetchApi's one-shot refresh-retry and never needed this fix).
    // Resolves at ~1000ms, deliberately close to the original loop's
    // real worst-case coverage (~1100ms) rather than an easy near-0ms
    // case — a 600ms bounded retry would NOT survive this window, only
    // the corrected ~1200ms one does, so this asserts the fix actually
    // covers the boundary the race needs, not just an easy case of it.
    getMeMock.mockImplementation(async () => {
      if (Date.now() - testStart < 1000) {
        throw new ApiError(401, "Unauthorized", "Unauthorized");
      }
      return { organizations: [], current_org_id: null };
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    let latestCtx: OrgContextType | undefined;
    render(
      <QueryClientProvider client={queryClient}>
        <OrgProvider>
          <Consumer onReady={(ctx) => { latestCtx = ctx; }} />
        </OrgProvider>
      </QueryClientProvider>,
    );

    // The mount-time `useMeQuery` fetch hits the 401 immediately
    // (t≈0, well inside the simulated 1000ms propagation window) and
    // must recover via the bounded ~1200ms retry — by which point the
    // mock has "propagated" and returns success — rather than ever
    // setting the session-expired banner.
    //
    // NOTE: `latestCtx.loading` is not a reliable "recovery finished"
    // signal here — it mirrors `meQuery.isLoading`, which flips back
    // to false right after the *initial* failed fetch settles (long
    // before the ~1200ms bounded retry even starts). Wait on the
    // recovery's own retry call instead: the initial mount fetch is
    // 1 call; once the bounded retry has fired, the count is >= 2.
    await waitFor(
      () => expect(getMeMock.mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 4000 },
    );
    // ...and let that retry's promise chain (applyMeToOrgState /
    // setAuthError / sessionStorage.removeItem) actually settle.
    await waitFor(() => expect(latestCtx?.authError).toBeNull(), {
      timeout: 4000,
    });
    await waitFor(
      () =>
        expect(
          typeof window === "undefined"
            ? null
            : window.sessionStorage.getItem("eden:auth:error"),
        ).not.toBe("session_expired"),
      { timeout: 4000 },
    );

    expect(latestCtx?.authErrorKind).not.toBe("session");
    expect(latestCtx?.authError).toBeNull();
    if (typeof window !== "undefined") {
      expect(window.sessionStorage.getItem("eden:auth:error")).not.toBe(
        "session_expired",
      );
    }

    // Exactly one recovery cycle: the initial (failing) attempt plus
    // ONE bounded retry, each up to 2 physical calls per the
    // invalidate-then-fetch pairing described above — never more.
    expect(getMeMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(getMeMock.mock.calls.length).toBeLessThanOrEqual(4);
  });
});
