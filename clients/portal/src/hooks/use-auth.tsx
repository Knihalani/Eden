"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/lib/api";
import type { User, Organization } from "@/lib/types";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch the Eden-side profile (orgs + current org) from FastAPI. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

/**
 * Map a Clerk user + Eden org payload to Eden's `User` shape so the
 * rest of the portal (which already consumes `user.user_id`,
 * `user.email`, `user.name`, `user.organizations`, `user.current_org_id`)
 * keeps working without per-call refactors.
 *
 * Clerk owns identity (id, email, name). Eden owns org membership +
 * which org is currently selected — those still come from FastAPI's
 * `/auth/me` endpoint, which accepts the Clerk session JWT in the
 * `Authorization` header.
 */
function buildEdenUser(
  clerkUser: {
    id: string;
    emailAddresses: Array<{ emailAddress: string }>;
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
  },
  organizations: Organization[],
  currentOrgId: string | null,
): User {
  const email = clerkUser.emailAddresses[0]?.emailAddress ?? "";
  const name =
    clerkUser.fullName ||
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
    email.split("@")[0] ||
    "User";

  return {
    user_id: clerkUser.id,
    email,
    name,
    organizations,
    current_org_id: currentOrgId,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { user: clerkUser, isLoaded: clerkLoaded } = useUser();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the Eden-side profile (orgs + current org) once Clerk is ready
  // and we have a signed-in user. Failures are non-fatal — the user
  // can still see the portal shell.
  const refreshUser = useCallback(async () => {
    if (!clerkUser) {
      setOrganizations([]);
      setCurrentOrgId(null);
      return;
    }
    setProfileLoading(true);
    try {
      const me = await api.getMe();
      setOrganizations(me.organizations ?? []);
      setCurrentOrgId(me.current_org_id ?? null);
      setError(null);
    } catch (err) {
      // Surface as a soft error — the user is signed in, they just
      // don't have an Eden org yet (typical on first signup).
      setError(err instanceof Error ? err.message : "Failed to load profile");
    } finally {
      setProfileLoading(false);
    }
  }, [clerkUser]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const user: User | null = clerkUser
    ? buildEdenUser(clerkUser, organizations, currentOrgId)
    : null;

  return (
    <AuthContext.Provider
      value={{
        user,
        // `loading` is true until Clerk has resolved session state.
        // Once resolved, profile loading is reported via `error` (null
        // = loaded fine). Existing consumers treat a non-null user as
        // "ready" and a null user as "logged out" — both still work.
        loading:
          !clerkLoaded ||
          (!!clerkUser && profileLoading && organizations.length === 0),
        error,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}

// Sign-in / sign-up / sign-out are handled by Clerk directly:
//   - Pages: <SignIn /> / <SignUp /> in src/app/sign-{in,up}/[[...]]/page.tsx
//   - Sign-out: `useClerk().signOut()` from @clerk/nextjs
// Keep this comment so future readers don't reach for useAuth() helpers.