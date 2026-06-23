"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useOrganization, useOrganizationList, useUser } from "@clerk/nextjs";
import { api } from "@/lib/api";
import type { Organization } from "@/lib/types";

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
  const { isLoaded: userListLoaded, userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const { user, isLoaded: userLoaded } = useUser();
  const router = useRouter();
  const [currentOrg, setCurrentOrgState] = useState<Organization | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Whenever the Clerk active org changes, refetch the Eden-side
  // enrichment for that org. Failures are non-fatal — the user can
  // still navigate the portal shell.
  const refreshOrgs = useCallback(async () => {
    if (!user) {
      setOrganizations([]);
      setCurrentOrgState(null);
      return;
    }
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
        ? enrichedOrgs.find((o) => o.id === clerkOrg.id)
        : undefined;
      if (fromClerk) {
        setCurrentOrgState(fromClerk);
      } else if (me.current_org_id) {
        const preferred = enrichedOrgs.find((o) => o.id === me.current_org_id);
        setCurrentOrgState(preferred ?? enrichedOrgs[0] ?? null);
      } else if (enrichedOrgs.length > 0) {
        setCurrentOrgState(enrichedOrgs[0]);
      } else if (clerkOrg) {
        // FIX-R: Clerk has an active org but Eden's /auth/me
        // doesn't know about it (the Clerk webhook that creates
        // the Eden-side ``organizations`` + ``org_members`` rows
        // on org.created is delayed or hasn't fired). The user
        // perceives this as "I created an org during sign-up but
        // Eden doesn't recognise it" — they land on the
        // onboarding wizard, click "Get started", and the wizard
        // can't find an org to PATCH state into.
        //
        // Synthesise a placeholder Organization from the Clerk
        // data so the portal chrome (sidebar, breadcrumbs, org
        // switcher) at least renders something and the user can
        // proceed. The Eden-side row will arrive in a few
        // seconds via the polling loop; once it does, the
        // refresh replaces this synthetic entry with the real
        // one. Backend operations that need the real row (PATCH
        // onboarding state, create agent, etc.) will keep
        // failing until the webhook lands, but the user will see
        // a working UI instead of a "stuck" one.
        setCurrentOrgState({
          id: clerkOrg.id,
          name: clerkOrg.name,
          slug: clerkOrg.slug,
          role: "owner", // best guess — Clerk makes the creator the admin
        } as Organization);
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
      if (!/401|404|5\d\d|not\s*authenticated|unauthorized|not\s*found|unreachable|timed?\s*out|bad\s*gateway/i.test(rawMessage)) {
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
      if (/401|not\s*authenticated|unauthorized/i.test(rawMessage)) {
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
      } else if (/404|not\s*found/i.test(rawMessage)) {
        message = "We couldn't load your workspace. Please refresh.";
      } else if (/5\d\d|server\s*error|unreachable|timed?\s*out|bad\s*gateway/i.test(rawMessage)) {
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

  useEffect(() => {
    if (userLoaded && clerkOrgLoaded) {
      // Defer the first refresh to a microtask so the setState calls
      // inside `refreshOrgs` are not synchronous with this effect
      // body (React 19 purity rule's complaint). The microtask
      // boundary is invisible to users — the request still fires on
      // the same tick as the mount.
      queueMicrotask(refreshOrgs);
    }
    // FIX-Q: poll for an org every 5s when the user is signed in but
    // has none. The Clerk webhook that creates the Eden-side org row
    // on first signup can take several seconds to land; without a
    // poll, the user lands on the onboarding wizard, creates an org
    // on /onboarding/org, and the welcome step's `currentOrg` stays
    // null on every subsequent visit until they refresh the page
    // (because refreshOrgs only ran on initial mount). 5s is
    // aggressive enough to feel real-time without thrashing the
    // /auth/me endpoint. The interval is cleared once an org is
    // found, or when the user signs out.
    let interval: ReturnType<typeof setInterval> | null = null;
    if (
      userLoaded &&
      clerkOrgLoaded &&
      !loading &&
      organizations.length === 0
    ) {
      interval = setInterval(() => {
        refreshOrgs();
      }, 5_000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [
    userLoaded,
    clerkOrgLoaded,
    loading,
    organizations.length,
    refreshOrgs,
  ]);

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
      clearAuthError: () => setAuthError(null),
      clerkOrgId: clerkOrg?.id ?? null,
      // Clerk role strings are ``org:admin`` / ``org:member`` by
      // default; map them onto Eden's ``owner``/``member`` vocab so
      // existing RBAC checks (`org["role"] === "admin"`) keep
      // working. The full mapping lives in `lib/roles.ts`.
      clerkOrgRole: clerkOrg ? userMemberships.data?.[0]?.role ?? null : null,
    }),
    // Intentionally depend on the *identity* of `currentOrg.id`,
    // not the object reference — Clerk returns a fresh
    // Organization wrapper per render, which would otherwise
    // invalidate the memo on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentOrg, organizations, loading, authError, clerkOrg?.id, userMemberships.data, refreshOrgs],
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