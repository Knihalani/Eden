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
import { useOrganization, useOrganizationList, useUser } from "@clerk/nextjs";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/core";
import type { Organization } from "@/lib/types";
import { usePolling } from "./use-polling";
import {
  fetchMeQuery,
  useMeQuery,
  type MeResponse,
} from "@/hooks/use-me-query";
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
  const { organization: clerkOrg, isLoaded: clerkOrgLoaded } = useOrganization();
  const { userMemberships, isLoaded: _userMembershipsLoaded } =
    useOrganizationList({
      userMemberships: { infinite: true },
    });
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

  const authErrorRef = useRef<string | null>(null);
  const authErrorKindRef = useRef<AuthErrorKind | null>(null);
  useEffect(() => {
    authErrorRef.current = authError;
    authErrorKindRef.current = authErrorKind;
  }, [authError, authErrorKind]);

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
    queryClient.clear();
    void fetchMeQuery(queryClient).catch(() => {
      /* mapOrgLoadError via meQuery.error */
    });
  }, [clerkOrg?.id, clerkOrgLoaded, queryClient]);

  // Mirror shared RQ cache into local org selection state.
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
    mapOrgLoadError(
      meQuery.error,
      setAuthError,
      setAuthErrorKind,
      setOrganizations,
      setCurrentOrgState,
    );
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
      const delays = [0, 300, 800];
      let me: MeResponse | null = null;
      let lastErr: unknown = null;
      for (const ms of delays) {
        if (ms > 0) await new Promise((r) => setTimeout(r, ms));
        try {
          me = await fetchMeQuery(queryClient);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const status = e instanceof ApiError ? e.status : undefined;
          // Retry only on 401 by status — sanitized messages lose auth signals.
          if (status !== 401) break;
        }
      }
      if (!me) throw lastErr ?? new Error("Failed to load orgs");
      applyMeToOrgState(me, clerkOrg, setOrganizations, setCurrentOrgState);
      setAuthError(null);
      setAuthErrorKind(null);
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem("eden:auth:error");
      }
    } catch (e) {
      mapOrgLoadError(
        e,
        setAuthError,
        setAuthErrorKind,
        setOrganizations,
        setCurrentOrgState,
      );
    } finally {
      setLoading(false);
    }
  }, [user, clerkOrg, queryClient]);

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
    intervalMs: 5_000,
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
        queryClient.clear();
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
      clerkOrgRole: clerkOrg
        ? (userMemberships.data?.find(
            (m) => m.organization?.id === clerkOrg.id,
          )?.role ?? null)
        : null,
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
      userMemberships.data,
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
