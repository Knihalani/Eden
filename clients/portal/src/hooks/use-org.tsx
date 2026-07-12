"use client";

import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useOrganization, useOrganizationList, useUser } from "@clerk/nextjs";
import { api, ApiError } from "@/lib/api";
import type { Organization } from "@/lib/types";
import { usePolling } from "./use-polling";

interface OrgContextType {
  currentOrg: Organization | null;
  organizations: Organization[];
  setCurrentOrg: (org: Organization | null) => void;
  refreshOrgs: () => Promise<void>;
  /** Alias for ``refreshOrgs`` — kept for backwards compat with
   *  onboarding code that uses the shorter name. */
  refreshOrg: () => Promise<void>;
  loading: boolean;
  /** Non-fatal auth error (e.g. 401 from /api/proxy/auth/me). When set,
   *  the consuming page should render a "Session expired" card with a
   *  re-auth button. Cleared by the user clicking "Sign in" + retry. */
  authError: string | null;
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

/**
 * Bridges Clerk's active organization to Eden's portal org context.
 *
 * Identity of truth for which org is active: Clerk (via
 * ``useOrganization()`` + ``OrganizationSwitcher``). The Eden-side
 * enrichment (member_count, archived_at, the local
 * ``org_members`` row for permission checks) is fetched from FastAPI
 * via ``/auth/me`` and merged into the ``Organization`` shape the
 * rest of the portal already consumes.
 *
 * If Clerk says the user has no active org, ``currentOrg`` is
 * ``null`` and the (portal)/layout's ``no-org-state`` component
 * prompts the user to pick one (or create a new one via
 * ``<CreateOrganization />``).
 */
export function OrgProvider({ children }: { children: ReactNode }) {
  const { organization: clerkOrg, isLoaded: clerkOrgLoaded } = useOrganization();
  const { userMemberships, isLoaded: _userMembershipsLoaded } = useOrganizationList({
    userMemberships: { infinite: true } });
  const { user, isLoaded: userLoaded } = useUser();
  const __router = useRouter();
  const [currentOrg, setCurrentOrgState] = useState<Organization | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [orgSyncTimedOut, setOrgSyncTimedOut] = useState(false);
  const orgSyncStartedAtRef = useRef<number | null>(null);

  // Use a ref to mirror `authError` so the 5s polling interval can
  // bail immediately on failure without waiting for the React state
  // to propagate. Without this, the interval closure captures
  // `authError` at setup time and the next tick (or two) still calls
  // `refreshOrgs` after authError becomes truthy, hammering /me
  // until the 429 limit trips. June 2026 fix.
  const authErrorRef = useRef<string | null>(null);
  useEffect(() => {
    authErrorRef.current = authError;
  }, [authError]);

  // Whenever the Clerk active org changes, refetch the Eden-side
  // enrichment for that org. Failures are non-fatal — the user can
  // still navigate the portal shell.
  const refreshOrgs = useCallback(async () => {
    if (!user) {
      setOrganizations([]);
      setCurrentOrgState(null);
      return;
    }
    // Synchronous bail when the last attempt failed — prevents the
    // 5s polling loop from re-firing before the effect cleanup runs.
    if (authErrorRef.current) return;
    setLoading(true);
    try {
      const me = await api.getMe();
      const enrichedOrgs: Organization[] = me.organizations ?? [];
      setOrganizations(enrichedOrgs);

      // Prefer the Clerk-active org if Eden knows about it; otherwise
      // fall back to the user's ``current_org_id``; otherwise the
      // first org in the list. (Same fallback chain as before.)
      //
      // Clerk-null branch: when the user has joined an Eden org via
      // an invite but hasn't been synced into the matching Clerk
      // organization yet (``clerkOrg === null``), don't clear the
      // Eden-side state — the user can still proceed through the
      // onboarding wizard with the Eden org as the active context.
      // The (portal) layout's Clerk ``<OrganizationSwitcher>`` will
      // render empty until the membership webhook syncs, which is
      // acceptable for the brief window between invite-accept and
      // webhook delivery.
      const fromClerk = clerkOrg
        ? enrichedOrgs.find(
            (o) =>
              o.clerk_org_id === clerkOrg.id ||
              o.id === clerkOrg.id,
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
      // FIX-J: clear the sticky auth banner on success. The previous
      // implementation never reset `authError` on a successful
      // /auth/me, so a transient 401 during onboarding left the
      // "Session expired" banner permanently on screen even after
      // the session was healthy. The user's live test showed
      // /auth/me returning 200 with valid user data but the banner
      // still visible — this is the cause.
      setAuthError(null);
    } catch (e) {
      // Only emit a console error for genuinely unexpected failures
      // (anything that isn't a known transient / handled class).
      // The user-friendly mapper below already produces a good
      // message for 401 / 404 / 5xx — logging the raw `Error` was
      // double-reporting every transient failure (cold-start 502,
      // webhook race 404, expired-token 401) and cluttering the
      // console with the same backtrace the user already saw a
      // friendly version of.
      const rawMessage = e instanceof Error ? e.message : "Failed to load orgs";
      const status = e instanceof ApiError ? e.status : undefined;
      // Also treat ApiError by status — backend 500 detail is often
      // "An unexpected error occurred" with no "500" substring, which
      // previously logged as "Unexpected org-load failure" and left
      // the raw string in the auth banner.
      if (
        !(typeof status === "number" && status >= 500) &&
        !/401|404|429|5\d\d|not\s*authenticated|unauthorized|not\s*found|unreachable|timed?\s*out|bad\s*gateway|rate.?limit|unexpected\s*error|internal\s*error/i.test(rawMessage)
      ) {
        console.error("Unexpected org-load failure:", e);
      }
      // ponytail: a 401 here means the Clerk session is valid
      // (useUser() returned a user) but the portal's /api/proxy/auth/me
      // route is failing to forward it to FastAPI. Before this fix, the
      // dashboard stayed in its loading skeleton forever because
      // `currentOrg` stayed null. Now we surface the error and
      // redirect to the sign-in page so the user can re-establish
      // a fresh session. June 2026 fix.
      // Map raw API errors onto user-friendly copy. We deliberately
      // avoid surfacing backend internals ("User not found",
      // traceback fragments) to the end user — those leaked before
      // and were confusing. The exception is the generic
      // "Session expired" path for 401.
      let message: string;
      if (
        status === 401 ||
        /401|not\s*authenticated|authentication\s*required|unauthorized/i.test(rawMessage)
      ) {
        message = "Session expired. Please sign in again.";
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem("eden:auth:error", "session_expired");
        }
      } else if (/user\s*not\s*found/i.test(rawMessage)) {
        // June 22 2026 fix: this used to leak raw "User not found"
        // to the dashboard after a Clerk signup when the webhook
        // hadn't synced yet. Now the message tells the user to wait
        // a moment — the auto-provision path will pick up the Clerk
        // user on the next refresh, and the redirect to onboarding
        // lets them proceed without an org.
        message =
          "Setting up your account… If this takes more than a moment, refresh the page.";
      } else if (status === 404 || /404|not\s*found/i.test(rawMessage)) {
        message = "We couldn't load your workspace. Please refresh.";
      } else if (status === 429 || /429|rate.?limit/i.test(rawMessage)) {
        message = "Too many requests — pausing briefly. Reload in a moment.";
      } else if (
        (typeof status === "number" && status >= 500) ||
        /5\d\d|server\s*error|unreachable|timed?\s*out|bad\s*gateway|unexpected\s*error|internal\s*error/i.test(rawMessage)
      ) {
        message = "Eden is having trouble reaching the server. Please try again in a moment.";
      } else {
        message = rawMessage;
      }
      setAuthError(message);
      // Preserve any in-flight org state on transient / handled
      // errors — nuking ``currentOrg`` here used to clear the
      // optimistic org the onboarding wizard had just pinned, so a
      // 404 mid-flow kicked the user back to the org picker.
      if (
        !/401|user\s*not\s*found/i.test(rawMessage)
        && currentOrg
      ) {
        // keep currentOrg; only clear the noisy auth banner
      } else {
        setOrganizations([]);
        setCurrentOrgState(null);
      }
    } finally {
      setLoading(false);
    }
  }, [user, clerkOrg]);

  const orgSyncing = Boolean(
    clerkOrg?.id &&
      !authError &&
      !loading &&
      organizations.length === 0 &&
      !organizations.some(
        (o) => o.clerk_org_id === clerkOrg?.id || o.id === clerkOrg?.id,
      ),
  );

  // Stop infinite "Syncing workspace…" after ~45s — surface a retry CTA.
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

  useEffect(() => {
    if (userLoaded && clerkOrgLoaded) {
      // Defer the first refresh to a microtask so the setState calls
      // inside `refreshOrgs` are not synchronous with this effect
      // body (React 19 purity rule's complaint). The microtask
      // boundary is invisible to users — the request still fires on
      // the same tick as the mount.
      queueMicrotask(refreshOrgs);
    }
  }, [userLoaded, clerkOrgLoaded, refreshOrgs]);

  // FIX-Q: poll for an org every 5s when the user is signed in but
  // has none. The Clerk webhook that creates the Eden-side org row
  // on first signup can take several seconds to land; without a
  // poll, the user lands on the onboarding wizard, creates an org
  // on /onboarding/org, and the welcome step's `currentOrg` stays
  // null on every subsequent visit until they refresh the page.
  //
  // Site-wide fix (July 2026): we delegate to the cost-safe
  // ``usePolling`` hook instead of a hand-rolled ``setInterval``,
  // so the cadence inherits:
  //   - visibility-pause (a backgrounded tab contributes 0 req/min
  //     to the gateway — this is the 429 source on Vercel edge)
  //   - exponential backoff with full jitter (matches lib/api.ts
  //     so N concurrent failures don't synchronously re-trip 429)
  //   - permanent bail on 401/403 (no leaks once the session is
  //     known to be broken)
  //   - automatic cleanup on unmount
  //
  // Must be called at the top level of the component (rules-of-hooks);
  // the conditional cadence is encoded as the ``enabled`` flag.
  usePolling({
    fetch: () => refreshOrgs(),
    intervalMs: 5_000,
    // Jul 2026 fix: ``loading`` is no longer part of the deps.
    // ``refreshOrgs`` flips ``loading`` true → false on every call,
    // and including it in the deps caused ``usePolling`` to tear
    // down + re-create its effect (firing an immediate ``tick()``)
    // on every state flip. Combined with a 429 window that meant
    // every re-arm immediately re-tried the upstream and re-tripped
    // the rate limiter — exactly the spam the user observed. The
    // ``enabled`` gate already keeps the poll paused during a
    // pending call, so removing it from deps doesn't change
    // correctness.
    deps: [userLoaded, clerkOrgLoaded, organizations.length, !!authError],
    enabled:
      userLoaded &&
      clerkOrgLoaded &&
      !loading &&
      !authError &&
      organizations.length === 0,
  });

  const setCurrentOrg = useCallback((org: Organization | null) => {
    // Note: in practice, switching the active org is done via Clerk's
    // ``<OrganizationSwitcher />`` — the local setter here only exists
    // for the few places that need to optimistically pin an org
    // before the Clerk switch resolves (e.g. onboarding wizard).
    setCurrentOrgState(org);
  }, []);

  // Memoize the context value so consumers don't re-render on every
  // parent render (Clerk's useOrganization / useUser can return
  // unstable object references per render). Without this, any
  // consumer's ``useEffect(..., [currentOrg])`` re-fires on every
  // parent render, which previously caused the dashboard to
  // hammer 404 endpoints in a tight loop until 429. June 2026
  // hardening — see FIX on dashboard/page.tsx.
  const contextValue = useMemo<OrgContextType>(
    () => ({
      currentOrg,
      organizations,
      setCurrentOrg,
      refreshOrgs,
      refreshOrg: refreshOrgs,
      loading,
      authError,
      clearAuthError: () => {
        authErrorRef.current = null;
        setAuthError(null);
      },
      clerkOrgId: clerkOrg?.id ?? null,
      clerkOrgRole: clerkOrg
        ? userMemberships.data?.find(
            (m) => m.organization?.id === clerkOrg.id,
          )?.role ?? null
        : null,
      orgSyncing,
      orgSyncTimedOut,
    }),
    // Intentionally depend on the *identity* of `currentOrg.id`,
    // not the object reference — Clerk returns a fresh
    // Organization wrapper per render, which would otherwise
    // invalidate the memo on every parent render.
     
    [currentOrg, organizations, loading, authError, clerkOrg?.id, userMemberships.data, refreshOrgs, orgSyncing, orgSyncTimedOut],
  );

  return (
    <OrgContext.Provider value={contextValue}>
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg() {
  const context = useContext(OrgContext);
  if (!context) {
    throw new Error("useOrg must be used within OrgProvider");
  }
  return context;
}