"use client";

import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useUser } from "@clerk/nextjs";
import { useQueryClient } from "@tanstack/react-query";
import type { User, Organization } from "@/lib/types";
import { fetchMeQuery, isUserNotFoundRace, useMeQuery } from "@/hooks/use-me-query";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch the Eden-side profile (orgs + current org) from FastAPI.
   *  Returns ``{ ok: boolean; error?: string; err?: unknown }`` so the
   *  retry wrapper can distinguish the transient "User not found" race
   *  (retryable via status+detail) from a real auth failure (terminal). */
  refreshUser: () => Promise<{ ok: boolean; error?: string; err?: unknown }>;
  /** Same as ``refreshUser`` but with built-in retry on the transient
   *  "User not found" race that surfaces on the first /auth/me call
   *  after Clerk signup. */
  refreshUserWithRetry: () => Promise<void>;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const { user: clerkUser, isLoaded: clerkLoaded } = useUser();
  const queryClient = useQueryClient();
  const meEnabled = clerkLoaded && Boolean(clerkUser);
  const meQuery = useMeQuery(meEnabled);

  const organizations: Organization[] = (meQuery.data?.organizations ??
    []) as Organization[];
  const currentOrgId = meQuery.data?.current_org_id ?? null;

  const refreshUser = useCallback(async (): Promise<{
    ok: boolean;
    error?: string;
    /** Present on failure — use for status/detail machine matching. */
    err?: unknown;
  }> => {
    if (!clerkUser) {
      return { ok: true };
    }
    try {
      await fetchMeQuery(queryClient);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load profile";
      return { ok: false, error: msg, err };
    }
  }, [clerkUser, queryClient]);

  /**
   * Re-fetch the Eden-side profile, retrying on the transient
   * "User not found" error that surfaces during the first /auth/me
   * call after signup. The backend's /auth/me auto-provisions the
   * Postgres user on the first call, but a Clerk session refresh
   * landing a fraction of a second before that insert resolves can
   * cause the very first /auth/me to 404. Two quick retries with a
   * short backoff (250ms, 500ms) cover the typical race window
   * without leaving the user staring at a stuck banner.
   *
   * Jul 2026 fix: 401 / 403 / 429 / 5xx errors are *not* retried
   * here. fetchApi already waits on the upstream's ``Retry-After``
   * header for 429 (and backsoff with full jitter for 5xx) inside
   * a single invocation, so retrying on top of that here used to
   * turn one rate-limited call into seven within a second. The
   * outer AuthProvider's `error` state is set so the caller can
   * show a banner, and the layout's retry button is the user's
   * escape hatch once the upstream cools down.
   *
   * Wave 4: key the race retry on ``status===404`` + raw ApiError
   * detail — sanitized ``message`` is never ``User not found``.
   */
  const refreshUserWithRetry = useCallback(async () => {
    const delays = [0, 250, 500];
    for (const ms of delays) {
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      const { ok, err } = await refreshUser();
      if (ok) return;
      if (!isUserNotFoundRace(err)) return;
    }
    await refreshUser();
  }, [refreshUser]);

  const user: User | null = clerkUser
    ? buildEdenUser(clerkUser, organizations, currentOrgId)
    : null;

  const error =
    meQuery.error instanceof Error
      ? meQuery.error.message
      : meQuery.error
        ? "Failed to load profile"
        : null;

  // Wait for Clerk *and* the first /auth/me resolve so portal chrome
  // does not treat empty orgs as "orgless" before the profile lands.
  const loading =
    !clerkLoaded || (meEnabled && meQuery.isLoading);

  const contextValue = useMemo<AuthContextType>(
    () => ({
      user,
      loading,
      error,
      refreshUser,
      refreshUserWithRetry,
    }),
    [user, loading, error, refreshUser, refreshUserWithRetry],
  );

  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
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
