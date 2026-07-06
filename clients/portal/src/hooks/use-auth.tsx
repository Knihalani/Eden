"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode } from "react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/lib/api";
import type { User, Organization } from "@/lib/types";

interface AuthContextType {
  user: User | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch the Eden-side profile (orgs + current org) from FastAPI.
   *  Returns ``{ ok: boolean; error?: string }`` so the retry wrapper
   *  can distinguish the transient "User not found" race (retryable)
   *  from a real auth failure (terminal). */
  refreshUser: () => Promise<{ ok: boolean; error?: string }>;
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
    current_org_id: currentOrgId };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { user: clerkUser, isLoaded: clerkLoaded } = useUser();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);
  const [_profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the Eden-side profile (orgs + current org) once Clerk is ready
  // and we have a signed-in user. Failures are non-fatal — the user
  // can still see the portal shell.
  //
  // Returns ``true`` on success, ``false`` if the call failed (so the
  // retry wrapper can detect the transient "User not found" race that
  // shows up on the very first /auth/me after Clerk signup, when the
  // backend's auto-provision hasn't completed yet).
  const refreshUser = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!clerkUser) {
      setOrganizations([]);
      setCurrentOrgId(null);
      return { ok: true };
    }
    setProfileLoading(true);
    try {
      const me = await api.getMe();
      setOrganizations(me.organizations ?? []);
      setCurrentOrgId(me.current_org_id ?? null);
      setError(null);
      return { ok: true };
    } catch (err) {
      // Surface as a soft error — the user is signed in, they just
      // don't have an Eden org yet (typical on first signup).
      const msg = err instanceof Error ? err.message : "Failed to load profile";
      setError(msg);
      return { ok: false, error: msg };
    } finally {
      setProfileLoading(false);
    }
  }, [clerkUser]);

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
   */
  const refreshUserWithRetry = useCallback(async () => {
    const delays = [0, 250, 500];
    for (const ms of delays) {
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      const { ok, error: errMsg } = await refreshUser();
      if (ok) return;
      const isUserNotFound = /user\s*not\s*found/i.test(errMsg ?? "");
      if (!isUserNotFound) return; // non-retryable — state already set
    }
    // Final attempt to refresh the (now stuck) error state.
    await refreshUser();
  }, [refreshUser]);

  useEffect(() => {
    // Use the retry variant on first mount so the auto-provision
    // race window doesn't bounce the user into the "Setting up your
    // account" banner during the first half-second after signup.
    refreshUserWithRetry();
    // We intentionally only run this once on mount — the refresh
    // function is recreated every render and depending on it would
    // trigger a refetch on every Clerk state change. The org-hook
    // (use-org) owns the refresh-on-clerk-org-change path.
    //
    // PQ-13: depend on ``clerkUser?.updatedAt`` in addition to ``id``
    // so accepting a new org invite in another tab triggers a re-fetch.
    // Pre-fix the dep array was ``[clerkUser?.id]`` alone, which left
    // the org list stale after an invite-accept until a full reload.

  }, [clerkUser?.id, clerkUser?.updatedAt]);

  const user: User | null = clerkUser
    ? buildEdenUser(clerkUser, organizations, currentOrgId)
    : null;

  return (
    <AuthContext.Provider
      value={{
        user,
        // ``loading`` is true only while Clerk is resolving session
        // state. Profile loading (the /auth/me round-trip) is reported
        // separately via ``error`` (null = loaded fine). The previous
        // ``profileLoading && organizations.length === 0`` guard held
        // the chrome in its skeleton forever on the first /auth/me
        // 404 (the auto-provision race), which is exactly the
        // window where the user perceives "nothing is clickable".
        loading: !clerkLoaded,
        error,
        refreshUser,
        refreshUserWithRetry }}
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