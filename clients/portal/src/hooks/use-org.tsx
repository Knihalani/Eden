"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useOrganization, useUser } from "@clerk/nextjs";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/core";
import type { Organization } from "@/lib/types";
import { usePolling } from "./use-polling";
import {
  fetchMeQuery,
  useMeQuery,
  type MeResponse,
} from "@/hooks/use-me-query";
import { dropOrgScopedQueries } from "@/lib/portal-query";
import {
  classifyOrgLoadError,
  type AuthErrorKind,
} from "@/lib/org-load-error";
import { isOrgSyncing } from "@/lib/org-syncing";

export type { AuthErrorKind };
export { classifyOrgLoadError };

interface OrgContextType {
  currentOrg: Organization | null;
  organizations: Organization[];
  setCurrentOrg: (org: Organization | null) => void;
  refreshOrgs: () => Promise<void>;
  /** Alias for ``refreshOrgs`` — kept for backwards compat with
   *  onboarding code that uses the shorter name. */
  refreshOrg: () => Promise<void>;
  loading: boolean;
  /** Non-fatal load error from /api/proxy/auth/me. Session kind →
   *  re-auth; server kind → degraded messaging without clearing a
   *  valid org. Cleared by Retry / successful me refetch. */
  authError: string | null;
  /** ``session`` only for 401/403; ``server`` for 5xx / rate / setup. */
  authErrorKind: AuthErrorKind | null;
  clearAuthError: () => void;
  /** Clerk's active org id (``null`` if user has no active org). */
  clerkOrgId: string | null;
  /** Clerk's active org role (``org:admin`` / ``org:member`` / null). */
  clerkOrgRole: string | null;
  /** Clerk has an active org but Eden has not synced the row yet. */
  orgSyncing: boolean;
  /** True after orgSyncing persisted too long without resolving. */
  orgSyncTimedOut: boolean;
}

const OrgContext = createContext<OrgContextType | null>(null);

function applyMeToOrgState(
  me: MeResponse,
  clerkOrg: { id: string } | null | undefined,
  setOrganizations: (orgs: Organization[]) => void,
  setCurrentOrgState: (org: Organization | null) => void,
) {
  const enrichedOrgs: Organization[] = (me.organizations ??
    []) as Organization[];
  setOrganizations(enrichedOrgs);

  const fromClerk = clerkOrg
    ? enrichedOrgs.find(
        (o) => o.clerk_org_id === clerkOrg.id || o.id === clerkOrg.id,
      )
    : undefined;
  if (fromClerk) {
    setCurrentOrgState(fromClerk);
  } else if (me.current_org_id) {
    const preferred = enrichedOrgs.find((o) => o.id === me.current_org_id);
    setCurrentOrgState(preferred ?? enrichedOrgs[0] ?? null);
  } else if (enrichedOrgs.length > 0) {
    setCurrentOrgState(enrichedOrgs[0]);
  } else {
    setCurrentOrgState(null);
  }
}

function mapOrgLoadError(
  e: unknown,
  setAuthError: (msg: string) => void,
  setAuthErrorKind: (kind: AuthErrorKind | null) => void,
  setOrganizations: (orgs: Organization[]) => void,
  setCurrentOrgState: (org: Organization | null) => void,
): void {
  const status = e instanceof ApiError ? e.status : undefined;
  if (
    !(typeof status === "number" && status >= 500) &&
    status !== 401 &&
    status !== 403 &&
    status !== 404 &&
    status !== 429
  ) {
    console.error("Unexpected org-load failure:", e);
  }

  const { kind, message, clearOrg } = classifyOrgLoadError(e);
  if (kind === "session" && typeof window !== "undefined") {
    // Always surface on the first 401/403 — silencing left authError null while
    // currentOrg stayed empty, so chrome/pages rendered NoOrgState instead of
    // the session-expired banner. Key off status, not sanitized message regex.
    //
    // "First" here means first AFTER ``recoverFromAuthPropagationRace``
    // (below) has already had one bounded chance to resolve a 401 —
    // every call site that can observe an org-load failure routes
    // through that helper before it ever reaches here (see its doc
    // comment). So a no-delay surface is still correct: a plain 403,
    // or a 401 that is still failing ~600ms later, is a real session
    // problem, not the post-signup propagation race.
    window.sessionStorage.setItem("eden:auth:error", "session_expired");
  }
  setAuthError(message);
  setAuthErrorKind(kind);
  // Clear org only on session failures / provision race — never on
  // 5xx/degraded when we already have a valid org selection.
  if (clearOrg) {
    setOrganizations([]);
    setCurrentOrgState(null);
  }
}

/**
 * Bridges Clerk's active organization to Eden's portal org context.
 *
 * Identity of truth for which org is active: Clerk (via
 * ``useOrganization()`` + Eden workspace switcher ``setActive``).
 * The Eden-side enrichment is fetched from FastAPI via shared
 * ``useMeQuery`` (``["auth","me"]``) so AuthProvider and OrgProvider
 * share one ``/auth/me`` network call.
 */
export function OrgProvider({ children }: { children: ReactNode }) {
  const { organization: clerkOrg, membership, isLoaded: clerkOrgLoaded } =
    useOrganization();
  const { user, isLoaded: userLoaded } = useUser();
  const queryClient = useQueryClient();
  const [currentOrg, setCurrentOrgState] = useState<Organization | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authErrorKind, setAuthErrorKind] = useState<AuthErrorKind | null>(
    null,
  );
  const [orgSyncTimedOut, setOrgSyncTimedOut] = useState(false);
  const orgSyncStartedAtRef = useRef<number | null>(null);
  // Tracks which me+clerk snapshot we've applied so hydrate can sync
  // during render (avoids empty-workspace flash before useEffect).
  const appliedMeKeyRef = useRef<string | null>(null);

  const authErrorRef = useRef<string | null>(null);
  const authErrorKindRef = useRef<AuthErrorKind | null>(null);
  useEffect(() => {
    authErrorRef.current = authError;
    authErrorKindRef.current = authErrorKind;
  }, [authError, authErrorKind]);

  // Dedup lock for the recovery attempt below — see its doc comment.
  // Both ``refreshOrgs`` and the mount-time ``meQuery.error`` effect
  // can observe the very same underlying 401 (they often share one
  // physical request via ``fetchApi``'s in-flight GET dedup), so this
  // ensures only ONE bounded wait-then-retry ever runs concurrently
  // instead of each caller independently sleeping 600ms.
  const authRecoveryRef = useRef<Promise<void> | null>(null);

  /**
   * Single owner of "wait for JWT propagation after signup".
   *
   * ce7f7a9f ("fix: GitHub App install slug, auth skeleton, post-signup
   * session") found a real backend race: right after Clerk sign-up,
   * the client can report a signed-in user before the session JWT is
   * forwardable/verifiable server-side. That commit fixed it with a
   * hand-rolled 3-attempt [0, 300, 800]ms *inter-attempt* retry loop
   * inside ``refreshOrgs`` — attempts landed at cumulative t≈0ms,
   * t≈300ms, and t≈1100ms (300+800), so the loop's real worst-case
   * coverage was ~1100ms, not the 800ms last-gap value alone.
   *
   * F41-3 removed that loop because it stacked with ``fetchApi``'s own
   * one-shot Clerk-token-refresh-then-retry (core.ts): each of the 3
   * loop iterations could itself trigger a fresh refresh-retry, so one
   * persistent 401 could burn up to 6 physical requests. But
   * ``fetchApi``'s retry is essentially INSTANT (``session.touch()`` +
   * ``getToken({skipCache:true})`` + immediate re-fetch) — it does not
   * reproduce the real wall-clock delay the JWT-propagation race needs,
   * so removing the loop entirely reopened that race: a 401 landing in
   * that window now falls straight through to ``mapOrgLoadError`` and
   * paints "Session expired" right after signup.
   *
   * This restores exactly ONE bounded wait + one retry for the 401
   * case, gated on status alone (there is no reliable "just signed up"
   * signal available here — no timestamp/flag is set anywhere in the
   * signup flow — so this applies to any 401, matching the F41-3
   * finding that ordinary token expiry already fails fast via
   * ``fetchApi``'s instant retry and would just cost one extra bounded
   * attempt here). Every call site that can see an org-load failure
   * (``refreshOrgs``'s catch AND the ``meQuery.error`` effect) routes
   * through THIS function instead of calling ``mapOrgLoadError``
   * directly, and the ref lock above collapses concurrent callers into
   * one attempt — so this can never regress into multiple overlapping
   * delays. Do not add another wait anywhere else in the auth-error
   * path.
   */
  const recoverFromAuthPropagationRace = useCallback(
    async (e: unknown): Promise<void> => {
      const status = e instanceof ApiError ? e.status : undefined;
      if (status !== 401) {
        mapOrgLoadError(
          e,
          setAuthError,
          setAuthErrorKind,
          setOrganizations,
          setCurrentOrgState,
        );
        return;
      }
      if (!authRecoveryRef.current) {
        authRecoveryRef.current = (async () => {
          // The original loop's real worst-case coverage was ~1100ms
          // (cumulative 0+300+800ms across 3 attempts), not the 800ms
          // last-gap value alone — wait long enough to match that
          // worst case (with a small buffer) in one bounded attempt,
          // rather than paying for all 3 original attempts.
          await new Promise((r) => setTimeout(r, 1200));
          try {
            const me = await fetchMeQuery(queryClient);
            applyMeToOrgState(me, clerkOrg, setOrganizations, setCurrentOrgState);
            setAuthError(null);
            setAuthErrorKind(null);
            if (typeof window !== "undefined") {
              window.sessionStorage.removeItem("eden:auth:error");
            }
          } catch (retryErr) {
            mapOrgLoadError(
              retryErr,
              setAuthError,
              setAuthErrorKind,
              setOrganizations,
              setCurrentOrgState,
            );
          } finally {
            authRecoveryRef.current = null;
          }
        })();
      }
      await authRecoveryRef.current;
    },
    [queryClient, clerkOrg],
  );

  // Global 401s from fetchApi (after Clerk refresh retry) surface here.
  useEffect(() => {
    function onSessionExpired(ev: Event) {
      const detail = (ev as CustomEvent<{ message?: string }>).detail;
      setAuthError(
        detail?.message?.trim() ||
          "Session expired. Sign in again to continue.",
      );
      setAuthErrorKind("session");
    }
    if (typeof window === "undefined") return;
    window.addEventListener(
      "eden:auth:session-expired",
      onSessionExpired as EventListener,
    );
    return () => {
      window.removeEventListener(
        "eden:auth:session-expired",
        onSessionExpired as EventListener,
      );
    };
  }, []);

  const meEnabled = userLoaded && clerkOrgLoaded && Boolean(user);
  const meQuery = useMeQuery(meEnabled);

  // Apply dehydrated / fetched ``/auth/me`` during render so BootGate and
  // banners see orgs on the same frame HydrationBoundary seeds the cache.
  if (meQuery.data) {
    const meKey = `${meQuery.dataUpdatedAt}:${clerkOrg?.id ?? ""}:${meQuery.data.current_org_id ?? ""}:${meQuery.data.organizations?.length ?? 0}`;
    if (appliedMeKeyRef.current !== meKey) {
      appliedMeKeyRef.current = meKey;
      applyMeToOrgState(
        meQuery.data,
        clerkOrg,
        setOrganizations,
        setCurrentOrgState,
      );
    }
  }

  // Drop org-scoped RQ cache when Clerk's active org changes, then
  // force a fresh ``/auth/me`` so enrichment matches the new org.
  const prevClerkOrgIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!clerkOrgLoaded) return;
    const nextId = clerkOrg?.id ?? null;
    if (prevClerkOrgIdRef.current === undefined) {
      prevClerkOrgIdRef.current = nextId;
      return;
    }
    if (prevClerkOrgIdRef.current === nextId) return;
    prevClerkOrgIdRef.current = nextId;
    // Clear Eden selection immediately so chrome never shows the
    // previous org while /auth/me remaps (orgSyncing covers the gap).
    setCurrentOrgState(null);
    dropOrgScopedQueries(queryClient);
    void fetchMeQuery(queryClient).catch(() => {
      /* mapOrgLoadError via meQuery.error */
    });
  }, [clerkOrg?.id, clerkOrgLoaded, queryClient]);

  // Mirror shared RQ cache into local org selection state when the
  // render-time apply above has not yet run (error recovery paths).
  // Depend on clerkOrg?.id (not the Clerk object) — a fresh object
  // identity every render re-ran this effect, called setOrganizations
  // with a new array, and tripped "Maximum update depth exceeded".
  useEffect(() => {
    if (!meQuery.data) return;
    applyMeToOrgState(
      meQuery.data,
      clerkOrg,
      setOrganizations,
      setCurrentOrgState,
    );
    setAuthError(null);
    setAuthErrorKind(null);
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem("eden:auth:error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clerkOrg object identity is unstable
  }, [meQuery.data, clerkOrg?.id]);

  useEffect(() => {
    if (!meQuery.error) return;
    // Routes through recoverFromAuthPropagationRace (not straight to
    // mapOrgLoadError) so the mount-time /auth/me fetch gets the same
    // one bounded retry chance a manual refreshOrgs() call does — see
    // that function's doc comment for why this must stay the only
    // place that owns the wait.
    void recoverFromAuthPropagationRace(meQuery.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to query error flips
  }, [meQuery.error]);

  const refreshOrgs = useCallback(async () => {
    if (!user) {
      setOrganizations([]);
      setCurrentOrgState(null);
      return;
    }
    // Session expiry blocks auto-refresh until the user retries; server
    // / degraded errors must stay retryable so a valid session is not
    // stuck behind a false "Sign in" wall.
    if (authErrorRef.current && authErrorKindRef.current === "session") return;
    setLoading(true);
    try {
      // F41-3: this used to hand-roll its own 3-attempt [0, 300, 800]ms
      // retry loop around a 401. That stacked on top of ``fetchApi``'s
      // own one-shot Clerk-token-refresh-then-retry (core.ts) — each
      // loop iteration could itself trigger a fresh refresh-retry, so
      // a persistent 401 could burn up to 6 physical requests instead
      // of 2. ``fetchApi`` now owns 401 transport retry exclusively;
      // a single call here is enough. Any lingering 401 falls through
      // to ``recoverFromAuthPropagationRace`` below, which gives the
      // post-signup JWT-propagation race (ce7f7a9f) exactly one bounded
      // extra retry before surfacing the session banner — see that
      // function's doc comment.
      const me = await fetchMeQuery(queryClient);
      applyMeToOrgState(me, clerkOrg, setOrganizations, setCurrentOrgState);
      setAuthError(null);
      setAuthErrorKind(null);
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem("eden:auth:error");
      }
    } catch (e) {
      await recoverFromAuthPropagationRace(e);
    } finally {
      setLoading(false);
    }
  }, [user, clerkOrg, queryClient, recoverFromAuthPropagationRace]);

  // Do not flash "syncing" while /auth/me is still in flight — empty
  // local orgs during the first fetch are not a sync gap yet. After a
  // Clerk org switch we null currentOrg; treat that (or a mismatched
  // Eden row) as syncing until me remaps.
  const orgSyncing = isOrgSyncing({
    clerkOrgId: clerkOrg?.id,
    currentOrg,
    authErrorKind,
    loading,
    meInFlight: Boolean(meEnabled && (meQuery.isLoading || meQuery.isFetching)),
  });

  useEffect(() => {
    if (!orgSyncing) {
      orgSyncStartedAtRef.current = null;
      setOrgSyncTimedOut(false);
      return;
    }
    if (orgSyncStartedAtRef.current === null) {
      orgSyncStartedAtRef.current = Date.now();
    }
    const elapsed = Date.now() - orgSyncStartedAtRef.current;
    const remaining = Math.max(0, 45_000 - elapsed);
    const timer = window.setTimeout(() => setOrgSyncTimedOut(true), remaining);
    return () => window.clearTimeout(timer);
  }, [orgSyncing]);

  // Polling when signed in with no Eden orgs (webhook race). Shares
  // the same ``["auth","me"]`` key via ``fetchMeQuery``.
  usePolling({
    fetch: () => refreshOrgs(),
    intervalMs: 20_000,
    deps: [
      userLoaded,
      clerkOrgLoaded,
      organizations.length,
      authErrorKind === "session",
    ],
    enabled:
      userLoaded &&
      clerkOrgLoaded &&
      !loading &&
      authErrorKind !== "session" &&
      organizations.length === 0,
  });

  const currentOrgIdRef = useRef<string | null>(null);
  useEffect(() => {
    currentOrgIdRef.current = currentOrg?.id ?? null;
  }, [currentOrg?.id]);

  const setCurrentOrg = useCallback(
    (org: Organization | null) => {
      const nextId = org?.id ?? null;
      if (currentOrgIdRef.current !== nextId) {
        dropOrgScopedQueries(queryClient);
        void fetchMeQuery(queryClient).catch(() => {
          /* mapOrgLoadError via meQuery.error */
        });
      }
      currentOrgIdRef.current = nextId;
      setCurrentOrgState(org);
    },
    [queryClient],
  );

  const clearAuthError = useCallback(() => {
    authErrorRef.current = null;
    authErrorKindRef.current = null;
    setAuthError(null);
    setAuthErrorKind(null);
  }, []);

  const contextValue = useMemo<OrgContextType>(
    () => ({
      currentOrg,
      organizations,
      setCurrentOrg,
      refreshOrgs,
      refreshOrg: refreshOrgs,
      loading: loading || (meEnabled && meQuery.isLoading),
      authError,
      authErrorKind,
      clearAuthError,
      clerkOrgId: clerkOrg?.id ?? null,
      clerkOrgRole: membership?.role ?? null,
      orgSyncing,
      orgSyncTimedOut,
    }),
    [
      currentOrg,
      organizations,
      loading,
      meEnabled,
      meQuery.isLoading,
      authError,
      authErrorKind,
      clearAuthError,
      clerkOrg?.id,
      membership?.role,
      refreshOrgs,
      orgSyncing,
      orgSyncTimedOut,
      setCurrentOrg,
    ],
  );

  return (
    <OrgContext.Provider value={contextValue}>{children}</OrgContext.Provider>
  );
}

export function useOrg() {
  const context = useContext(OrgContext);
  if (!context) {
    throw new Error("useOrg must be used within OrgProvider");
  }
  return context;
}
