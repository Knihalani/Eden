"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
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
      } else {
        setCurrentOrgState(enrichedOrgs[0] ?? null);
      }
    } catch (e) {
      console.error("Failed to load orgs:", e);
      // ponytail: a 401 here means the Clerk session is valid
      // (useUser() returned a user) but the portal's /api/proxy/auth/me
      // route is failing to forward it to FastAPI. Before this fix, the
      // dashboard stayed in its loading skeleton forever because
      // `currentOrg` stayed null. Now we surface the error and
      // redirect to the sign-in page so the user can re-establish
      // a fresh session. June 2026 fix.
      const message = e instanceof Error ? e.message : "Failed to load orgs";
      if (/401|not\s*authenticated|unauthorized/i.test(message)) {
        setAuthError("Session expired. Please sign in again.");
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem("eden:auth:error", "session_expired");
        }
        // Don't hard-redirect — let the consuming components render
        // a "Session expired" card with a "Sign in" button. The hard
        // redirect is reserved for pages that have no escape hatch.
      } else {
        setAuthError(message);
      }
      setOrganizations([]);
      setCurrentOrgState(null);
    } finally {
      setLoading(false);
    }
  }, [user, clerkOrg]);

  useEffect(() => {
    if (userLoaded && clerkOrgLoaded) {
      refreshOrgs();
    }
  }, [userLoaded, clerkOrgLoaded, refreshOrgs]);

  const setCurrentOrg = useCallback((org: Organization | null) => {
    // Note: in practice, switching the active org is done via Clerk's
    // ``<OrganizationSwitcher />`` — the local setter here only exists
    // for the few places that need to optimistically pin an org
    // before the Clerk switch resolves (e.g. onboarding wizard).
    setCurrentOrgState(org);
  }, []);

  return (
    <OrgContext.Provider
      value={{
        currentOrg,
        organizations,
        setCurrentOrg,
        refreshOrgs,
        loading,
        authError,
        clearAuthError: () => setAuthError(null),
        clerkOrgId: clerkOrg?.id ?? null,
        // Clerk role strings are ``org:admin`` / ``org:member`` by
        // default; map them onto Eden's ``owner``/``member`` vocab so
        // existing RBAC checks (`org["role"] === "admin"`) keep
        // working. The full mapping lives in `lib/roles.ts`.
        clerkOrgRole: clerkOrg ? userMemberships.data?.[0]?.role ?? null : null,
      }}
    >
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